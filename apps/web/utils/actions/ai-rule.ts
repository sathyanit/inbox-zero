"use server";

import { setUser } from "@sentry/nextjs";
import { auth } from "@/app/api/auth/[...nextauth]/auth";
import prisma, { isNotFoundError } from "@/utils/prisma";
import { ExecutedRuleStatus } from "@prisma/client";
import { getGmailClient } from "@/utils/gmail/client";
import { aiCreateRule } from "@/utils/ai/rule/create-rule";
import {
  runRules,
  type RunRulesResult,
} from "@/utils/ai/choose-rule/run-rules";
import { emailToContent, parseMessage } from "@/utils/mail";
import { getMessage, getMessages } from "@/utils/gmail/message";
import { executeAct } from "@/utils/ai/choose-rule/execute";
import { isDefined, type ParsedMessage } from "@/utils/types";
import { getSessionAndGmailClient } from "@/utils/actions/helpers";
import { type ActionError, isActionError } from "@/utils/error";
import {
  reportAiMistakeBody,
  type ReportAiMistakeBody,
  runRulesBody,
  type RunRulesBody,
  testAiCustomContentBody,
  type TestAiCustomContentBody,
} from "@/utils/actions/ai-rule.validation";
import {
  saveRulesPromptBody,
  type SaveRulesPromptBody,
} from "@/utils/actions/rule.validation";
import { aiPromptToRules } from "@/utils/ai/rule/prompt-to-rules";
import { aiDiffRules } from "@/utils/ai/rule/diff-rules";
import { aiFindExistingRules } from "@/utils/ai/rule/find-existing-rules";
import { aiGenerateRulesPrompt } from "@/utils/ai/rule/generate-rules-prompt";
import { getLabelById, getLabels } from "@/utils/gmail/label";
import { withActionInstrumentation } from "@/utils/actions/middleware";
import { createScopedLogger } from "@/utils/logger";
import { aiFindSnippets } from "@/utils/ai/snippets/find-snippets";
import { aiRuleFix } from "@/utils/ai/rule/rule-fix";
import { labelVisibility } from "@/utils/gmail/constants";
import type { CreateOrUpdateRuleSchemaWithCategories } from "@/utils/ai/rule/create-rule-schema";
import { deleteRule, safeCreateRule, safeUpdateRule } from "@/utils/rule/rule";
import { getUserCategoriesForNames } from "@/utils/category.server";
import { getAiUser } from "@/utils/user/get";

const logger = createScopedLogger("ai-rule");

export const runRulesAction = withActionInstrumentation(
  "runRules",
  async (unsafeBody: RunRulesBody): Promise<RunRulesResult | ActionError> => {
    const { success, data, error } = runRulesBody.safeParse(unsafeBody);
    if (!success) return { error: error.message };

    const { messageId, threadId, rerun, isTest } = data;

    const sessionResult = await getSessionAndGmailClient();
    if (isActionError(sessionResult)) return sessionResult;
    const { gmail, user: u } = sessionResult;

    const emailAccount = await getEmailAccountWithRules({ email: u.email });
    if (!emailAccount) return { error: "Email account not found" };

    const fetchExecutedRule = !isTest && !rerun;

    const [gmailMessage, executedRule] = await Promise.all([
      getMessage(messageId, gmail, "full"),
      fetchExecutedRule
        ? prisma.executedRule.findUnique({
            where: {
              unique_user_thread_message: {
                userId: emailAccount.userId,
                threadId,
                messageId,
              },
            },
            select: {
              id: true,
              reason: true,
              actionItems: true,
              rule: true,
            },
          })
        : null,
    ]);

    if (executedRule) {
      logger.info("Skipping. Rule already exists.", {
        email: emailAccount.email,
        messageId,
        threadId,
      });

      return {
        rule: executedRule.rule,
        actionItems: executedRule.actionItems,
        reason: executedRule.reason,
        existing: true,
        error: undefined,
      };
    }

    const message = parseMessage(gmailMessage);

    const result = await runRules({
      isTest,
      gmail,
      message,
      rules: emailAccount.user.rules,
      user: emailAccount,
    });

    return result;
  },
);

export const testAiCustomContentAction = withActionInstrumentation(
  "testAiCustomContent",
  async (unsafeBody: TestAiCustomContentBody) => {
    const { data, error } = testAiCustomContentBody.safeParse(unsafeBody);
    if (error) return { error: error.message };

    const { content } = data;

    const session = await auth();
    if (!session?.user.email) return { error: "Not logged in" };
    const gmail = getGmailClient(session);

    const emailAccount = await getEmailAccountWithRules({
      email: session.user.email,
    });
    if (!emailAccount) return { error: "Email account not found" };

    const result = await runRules({
      isTest: true,
      gmail,
      message: {
        id: "testMessageId",
        threadId: "testThreadId",
        snippet: content,
        textPlain: content,
        headers: {
          date: new Date().toISOString(),
          from: "",
          to: "",
          subject: "",
        },
        historyId: "",
        inline: [],
        internalDate: new Date().toISOString(),
      },
      rules: emailAccount.user.rules,
      user: emailAccount,
    });

    return result;
  },
);

export const createAutomationAction = withActionInstrumentation<
  [{ prompt: string }],
  { id: string },
  { existingRuleId?: string }
>("createAutomation", async ({ prompt }: { prompt: string }) => {
  const session = await auth();
  if (!session?.user.email) return { error: "Not logged in" };
  if (!session.accessToken) return { error: "No access token" };

  const emailAccount = await getEmailAccountWithRules({
    email: session.user.email,
  });
  if (!emailAccount) return { error: "Email account not found" };

  let result: CreateOrUpdateRuleSchemaWithCategories;

  try {
    result = await aiCreateRule(prompt, emailAccount);
  } catch (error: any) {
    return { error: `AI error creating rule. ${error.message}` };
  }

  if (!result) return { error: "AI error creating rule." };

  return await safeCreateRule({
    result,
    userId: emailAccount.userId,
  });
});

export const setRuleRunOnThreadsAction = withActionInstrumentation(
  "setRuleRunOnThreads",
  async ({
    ruleId,
    runOnThreads,
  }: {
    ruleId: string;
    runOnThreads: boolean;
  }) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    await prisma.rule.update({
      where: { id: ruleId, userId: session.user.id },
      data: { runOnThreads },
    });
  },
);

export const approvePlanAction = withActionInstrumentation(
  "approvePlan",
  async ({
    executedRuleId,
    message,
  }: {
    executedRuleId: string;
    message: ParsedMessage;
  }) => {
    const session = await auth();
    if (!session?.user.email) return { error: "Not logged in" };

    const gmail = getGmailClient(session);

    const executedRule = await prisma.executedRule.findUnique({
      where: { id: executedRuleId },
      include: { actionItems: true },
    });
    if (!executedRule) return { error: "Item not found" };

    await executeAct({
      gmail,
      message,
      executedRule,
      userEmail: session.user.email,
    });
  },
);

export const rejectPlanAction = withActionInstrumentation(
  "rejectPlan",
  async ({ executedRuleId }: { executedRuleId: string }) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    await prisma.executedRule.updateMany({
      where: { id: executedRuleId, userId: session.user.id },
      data: { status: ExecutedRuleStatus.REJECTED },
    });
  },
);

/**
 * Saves the user's rules prompt and updates the rules accordingly.
 * Flow:
 * 1. Authenticate user and validate input
 * 2. Compare new prompt with old prompt (if exists)
 * 3. If prompts differ:
 *    a. For existing prompt: Identify added, edited, and removed rules
 *    b. For new prompt: Process all rules as additions
 * 4. Remove rules marked for deletion
 * 5. Edit existing rules that have changes
 * 6. Add new rules
 * 7. Update user's rules prompt in the database
 * 8. Return counts of created, edited, and removed rules
 */
export const saveRulesPromptAction = withActionInstrumentation(
  "saveRulesPrompt",
  async (unsafeData: SaveRulesPromptBody) => {
    const session = await auth();
    const email = session?.user.email;
    if (!email) return { error: "Not logged in" };
    if (!session.accessToken) return { error: "No access token" };
    setUser({ email });

    logger.info("Starting saveRulesPromptAction", {
      email: session.user.email,
    });

    const { data, success, error } = saveRulesPromptBody.safeParse(unsafeData);
    if (!success) {
      logger.error("Input validation failed", {
        email: session.user.email,
        error: error.message,
      });
      return { error: error.message };
    }

    const emailAccount = await prisma.emailAccount.findUnique({
      where: { email },
      select: {
        rulesPrompt: true,
        aiProvider: true,
        aiModel: true,
        aiApiKey: true,
        email: true,
        userId: true,
        about: true,
        user: {
          select: {
            categories: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!emailAccount) {
      logger.error("Email account not found");
      return { error: "Email account not found" };
    }

    const oldPromptFile = emailAccount.rulesPrompt;
    logger.info("Old prompt file", {
      email,
      exists: oldPromptFile ? "exists" : "does not exist",
    });

    if (oldPromptFile === data.rulesPrompt) {
      logger.info("No changes in rules prompt, returning early", { email });
      return { createdRules: 0, editedRules: 0, removedRules: 0 };
    }

    let addedRules: Awaited<ReturnType<typeof aiPromptToRules>> | null = null;
    let editRulesCount = 0;
    let removeRulesCount = 0;

    // check how the prompts have changed, and make changes to the rules accordingly
    if (oldPromptFile) {
      logger.info("Comparing old and new prompts", { email });
      const diff = await aiDiffRules({
        user: emailAccount,
        oldPromptFile,
        newPromptFile: data.rulesPrompt,
      });

      logger.info("Diff results", {
        email,
        addedRules: diff.addedRules.length,
        editedRules: diff.editedRules.length,
        removedRules: diff.removedRules.length,
      });

      if (
        !diff.addedRules.length &&
        !diff.editedRules.length &&
        !diff.removedRules.length
      ) {
        logger.info("No changes detected in rules, returning early", { email });
        return { createdRules: 0, editedRules: 0, removedRules: 0 };
      }

      if (diff.addedRules.length) {
        logger.info("Processing added rules", { email });
        addedRules = await aiPromptToRules({
          user: emailAccount,
          promptFile: diff.addedRules.join("\n\n"),
          isEditing: false,
          availableCategories: emailAccount.user.categories.map((c) => c.name),
        });
        logger.info("Added rules", {
          email,
          addedRules: addedRules?.length || 0,
        });
      }

      // find existing rules
      const userRules = await prisma.rule.findMany({
        where: { userId: session.user.id, enabled: true },
        include: { actions: true },
      });
      logger.info("Found existing user rules", {
        email,
        count: userRules.length,
      });

      const existingRules = await aiFindExistingRules({
        user: emailAccount,
        promptRulesToEdit: diff.editedRules,
        promptRulesToRemove: diff.removedRules,
        databaseRules: userRules,
      });

      // remove rules
      logger.info("Processing rules for removal", {
        email,
        count: existingRules.removedRules.length,
      });
      for (const rule of existingRules.removedRules) {
        if (!rule.rule) {
          logger.error("Rule not found.", { email });
          continue;
        }

        const executedRule = await prisma.executedRule.findFirst({
          where: { userId: session.user.id, ruleId: rule.rule.id },
        });

        logger.info("Removing rule", {
          email,
          promptRule: rule.promptRule,
          ruleName: rule.rule.name,
          ruleId: rule.rule.id,
        });

        if (executedRule) {
          await prisma.rule.update({
            where: { id: rule.rule.id, userId: session.user.id },
            data: { enabled: false },
          });
        } else {
          try {
            await deleteRule({
              ruleId: rule.rule.id,
              userId: session.user.id,
              groupId: rule.rule.groupId,
            });
          } catch (error) {
            if (!isNotFoundError(error)) {
              logger.error("Error deleting rule", {
                email,
                ruleId: rule.rule.id,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
          }
        }

        removeRulesCount++;
      }

      // edit rules
      if (existingRules.editedRules.length > 0) {
        const editedRules = await aiPromptToRules({
          user: emailAccount,
          promptFile: existingRules.editedRules
            .map(
              (r) => `Rule ID: ${r.rule?.id}. Prompt: ${r.updatedPromptRule}`,
            )
            .join("\n\n"),
          isEditing: true,
          availableCategories: emailAccount.user.categories.map((c) => c.name),
        });

        for (const rule of editedRules) {
          if (!rule.ruleId) {
            logger.error("Rule ID not found for rule", {
              email,
              promptRule: rule.name,
            });
            continue;
          }

          logger.info("Editing rule", {
            email,
            promptRule: rule.name,
            ruleId: rule.ruleId,
          });

          const categoryIds = await getUserCategoriesForNames(
            session.user.id,
            rule.condition.categories?.categoryFilters || [],
          );

          editRulesCount++;

          await safeUpdateRule(rule.ruleId, rule, session.user.id, categoryIds);
        }
      }
    } else {
      logger.info("Processing new rules prompt with AI", { email });
      addedRules = await aiPromptToRules({
        user: emailAccount,
        promptFile: data.rulesPrompt,
        isEditing: false,
        availableCategories: emailAccount.user.categories.map((c) => c.name),
      });
      logger.info("Rules to be added", {
        email,
        count: addedRules?.length || 0,
      });
    }

    // add new rules
    for (const rule of addedRules || []) {
      logger.info("Creating rule", {
        email,
        promptRule: rule.name,
        ruleId: rule.ruleId,
      });

      await safeCreateRule({
        result: rule,
        userId: emailAccount.userId,
        categoryNames: rule.condition.categories?.categoryFilters || [],
      });
    }

    // update rules prompt for user
    await prisma.emailAccount.update({
      where: { email },
      data: { rulesPrompt: data.rulesPrompt },
    });

    logger.info("Completed", {
      email,
      createdRules: addedRules?.length || 0,
      editedRules: editRulesCount,
      removedRules: removeRulesCount,
    });

    return {
      createdRules: addedRules?.length || 0,
      editedRules: editRulesCount,
      removedRules: removeRulesCount,
    };
  },
);

/**
 * Generates a rules prompt based on the user's recent email activity and labels.
 * This function:
 * 1. Fetches the user's 20 most recent sent emails
 * 2. Retrieves the user's Gmail labels
 * 3. Calls an AI function to generate rule suggestions based on this data
 * 4. Returns the generated rules prompt as a string
 */
export const generateRulesPromptAction = withActionInstrumentation(
  "generateRulesPrompt",
  async () => {
    const session = await auth();
    const email = session?.user.email;
    if (!email) return { error: "Not logged in" };

    const user = await getAiUser({ email });

    if (!user) return { error: "User not found" };

    const gmail = getGmailClient(session);
    const lastSent = await getMessages(gmail, {
      query: "in:sent",
      maxResults: 50,
    });
    const gmailLabels = await getLabels(gmail);
    const userLabels = gmailLabels?.filter((label) => label.type === "user");

    const labelsWithCounts: { label: string; threadsTotal: number }[] = [];

    for (const label of userLabels || []) {
      if (!label.id) continue;
      if (label.labelListVisibility === labelVisibility.labelHide) continue;
      const labelById = await getLabelById({ gmail, id: label.id });
      if (!labelById?.name) continue;
      if (!labelById.threadsTotal) continue; // Skip labels with 0 threads
      labelsWithCounts.push({
        label: labelById.name,
        threadsTotal: labelById.threadsTotal || 0,
      });
    }

    const lastSentMessages = (
      await Promise.all(
        lastSent.messages?.map(async (message) => {
          if (!message.id) return null;
          const gmailMessage = await getMessage(message.id, gmail);
          return parseMessage(gmailMessage);
        }) || [],
      )
    ).filter(isDefined);
    const lastSentEmails = lastSentMessages?.map((message) => {
      return emailToContent(message, { maxLength: 500 });
    });

    const snippetsResult = await aiFindSnippets({
      user,
      sentEmails: lastSentMessages.map((message) => ({
        id: message.id,
        from: message.headers.from,
        replyTo: message.headers["reply-to"],
        cc: message.headers.cc,
        subject: message.headers.subject,
        content: emailToContent(message),
      })),
    });

    const result = await aiGenerateRulesPrompt({
      user,
      lastSentEmails,
      snippets: snippetsResult.snippets.map((snippet) => snippet.text),
      userLabels: labelsWithCounts.map((label) => label.label),
    });

    if (isActionError(result)) return { error: result.error };
    if (!result) return { error: "Error generating rules prompt" };

    return { rulesPrompt: result.join("\n\n") };
  },
);

export const setRuleEnabledAction = withActionInstrumentation(
  "setRuleEnabled",
  async ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    await prisma.rule.update({
      where: { id: ruleId, userId: session.user.id },
      data: { enabled },
    });
  },
);

export const reportAiMistakeAction = withActionInstrumentation(
  "reportAiMistake",
  async (unsafeBody: ReportAiMistakeBody) => {
    const session = await auth();
    if (!session?.user.email) return { error: "Not logged in" };

    const { success, data, error } = reportAiMistakeBody.safeParse(unsafeBody);
    if (!success) return { error: error.message };
    const { expectedRuleId, actualRuleId, email, explanation } = data;

    if (!expectedRuleId && !actualRuleId)
      return { error: "Either correct or incorrect rule ID is required" };

    const [expectedRule, actualRule, user] = await Promise.all([
      expectedRuleId
        ? prisma.rule.findUnique({
            where: { id: expectedRuleId, userId: session.user.id },
          })
        : null,
      actualRuleId
        ? prisma.rule.findUnique({
            where: { id: actualRuleId, userId: session.user.id },
          })
        : null,
      getAiUser({ email: session.user.email }),
    ]);

    if (expectedRuleId && !expectedRule)
      return { error: "Expected rule not found" };

    if (actualRuleId && !actualRule) return { error: "Actual rule not found" };

    if (!user) return { error: "User not found" };

    const content = emailToContent({
      textHtml: email.textHtml || undefined,
      textPlain: email.textPlain || undefined,
      snippet: email.snippet || "",
    });

    const result = await aiRuleFix({
      user,
      actualRule,
      expectedRule,
      email: {
        id: "",
        ...email,
        content,
      },
      explanation: explanation?.trim() || undefined,
    });

    if (isActionError(result)) return { error: result.error };
    if (!result) return { error: "Error fixing rule" };

    return {
      ruleId:
        result.ruleToFix === "actual_rule" ? actualRuleId : expectedRuleId,
      fixedInstructions: result.fixedInstructions,
    };
  },
);

async function getEmailAccountWithRules({ email }: { email: string }) {
  return prisma.emailAccount.findUnique({
    where: { email },
    select: {
      userId: true,
      email: true,
      about: true,
      aiProvider: true,
      aiModel: true,
      aiApiKey: true,
      user: {
        select: {
          rules: {
            where: { enabled: true },
            include: { actions: true, categoryFilters: true },
          },
        },
      },
    },
  });
}

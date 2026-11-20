import { z } from "zod";

import {
  laneOptions,
  lanes,
  projectStatuses,
  teamRoles,
  tiers,
  trades,
} from "@tawd/core/enums";

export const ALLOWED_EMAIL_DOMAIN = "velocitymedialab.com";

// Only VML staff get accounts. There is no public sign-up anywhere in TAWD.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address")
  .refine(
    (value) => value.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`),
    `Only @${ALLOWED_EMAIL_DOMAIN} addresses can have an account`,
  );

// Long enough to matter, with no composition rules: length beats a forced
// mix of symbols that people write on a sticky note.
export const MIN_PASSWORD_LENGTH = 12;

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200, "That password is too long");

export const createUserSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(120),
  email: emailSchema,
  isAdmin: z.boolean().default(false),
  roles: z.array(z.enum(teamRoles)).default([]),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "The two passwords do not match",
    path: ["confirmPassword"],
  })
  // On first sign-in, the whole point is to stop using the password an admin has seen.
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: "Choose a password different from the one you have now",
    path: ["newPassword"],
  });

export const signInSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter your email address")
    // Says nothing about which accounts exist: only this domain can have one.
    .refine(
      (value) => value.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`),
      `Use your ${ALLOWED_EMAIL_DOMAIN} address`,
    ),
  password: z.string().min(1, "Enter your password"),
});

/*
  Project rules come from skills/TAWD-PROFILE.md section 9:

  - Lane 1: no option, 1 to 3 concepts, normally 3.
  - Lane 2 Option A (client approved): no concepts at all, the design is built.
  - Lane 2 Option B (review and improve): 1 to 3 concepts, normally 1.
*/
export const projectSchema = z
  .object({
    clientName: z.string().trim().min(1, "Enter the client business name").max(200),
    trade: z.enum(trades),
    tier: z.enum(tiers),
    lane: z.enum(lanes),
    laneOption: z.enum(laneOptions).nullable().default(null),
    conceptCount: z.coerce.number().int().min(1).max(3).nullable().default(null),
    status: z.enum(projectStatuses).default("intake"),
    memberUserIds: z.array(z.string()).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.lane === "lane_1") {
      if (value.laneOption !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["laneOption"],
          message: "Lane 1 has no A or B option",
        });
      }
      if (value.conceptCount === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conceptCount"],
          message: "Choose how many concepts to build (1 to 3)",
        });
      }
      return;
    }

    if (value.laneOption === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["laneOption"],
        message: "Lane 2 needs option A or B",
      });
      return;
    }

    if (value.laneOption === "a" && value.conceptCount !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conceptCount"],
        message:
          "Option A builds the approved design directly, so it has no concepts",
      });
    }

    if (value.laneOption === "b" && value.conceptCount === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conceptCount"],
        message: "Choose how many concepts to build (1 to 3)",
      });
    }
  });

export type ProjectInput = z.infer<typeof projectSchema>;

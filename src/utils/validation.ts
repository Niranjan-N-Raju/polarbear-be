import { z } from 'zod';

const optionalText = (maxLength: number) =>
  z.string().max(maxLength, `Must be ${maxLength} characters or fewer.`).optional().transform((value) => value?.trim());

const optionalPhone = z
  .string()
  .optional()
  .transform((value) => value?.trim())
  .refine((value) => !value || /^\d{10}$/.test(value), 'Phone number must be exactly 10 digits.');

const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(200)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter.')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter.')
  .regex(/[0-9]/, 'Password must contain at least one digit.')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character.');

const nameSchema = z.string().min(1, 'Name is required.').max(100, 'Name must be 100 characters or fewer.').transform((value) => value.trim());
const emailSchema = z.string().min(1, 'Email is required.').max(254, 'Email is too long.').email('Invalid email format.').transform((value) => value.toLowerCase().trim());

export const storeBodySchema = z.object({
  name: nameSchema.pipe(z.string().max(100, 'Store name must be 100 characters or fewer.')),
  storeCode: z.string().min(1, 'Store code is required.').max(20, 'Store code must be 20 characters or fewer.').transform((value) => value.trim().toUpperCase()),
  address: optionalText(300),
  phone: optionalPhone,
  description: optionalText(500),
  storeType: z.enum(['company', 'franchise']).optional(),
  ownerName: optionalText(100),
  ownerPhone: optionalPhone,
  ownerEmail: z.preprocess((value) => value === '' ? undefined : value, emailSchema.optional()),
});

export const createUserSchema = z.object({
  name: nameSchema,
  email: emailSchema.optional(),
  password: z.string().max(200).optional(),
  role: z.enum(['admin', 'sub_admin', 'franchise_admin', 'employee']).optional(),
  franchiseIds: z.array(z.string().max(50)).max(50).optional(),
  phone: z.string().max(20).optional().transform((value) => value?.trim()),
});

export const patchUserSchema = z.object({
  name: nameSchema.optional(),
  role: z.enum(['admin', 'sub_admin', 'franchise_admin', 'employee']).optional(),
  franchiseIds: z.array(z.string().max(50)).max(50).optional(),
  phone: z.string().max(20).optional().transform((value) => value?.trim()),
});

export const profileSchema = z.object({
  name: nameSchema.optional(),
  currentPassword: z.string().max(200).optional(),
  newPassword: passwordSchema.optional(),
});

export { emailSchema, passwordSchema };

export function firstValidationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid input.';
}
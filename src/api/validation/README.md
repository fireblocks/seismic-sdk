# Validation Best Practices Guide

## Answering Your Questions

### 1. Is this the best practice to validate request params?

**YES** - The updated implementation follows industry best practices:

#### ✅ What We're Doing Right:

1. **Modular Validation** - Each part (params, query, body) is validated independently
2. **Middleware Pattern** - Validation happens before reaching controllers
3. **Type Safety** - Full TypeScript support with proper type inference
4. **Reusable Schemas** - Schemas are defined once and reused across routes
5. **Clear Error Messages** - User-friendly validation errors with field-level details
6. **Proper HTTP Status Codes** - Returns 400 for validation errors

#### 📚 Best Practice Example:

```typescript
// BEST PRACTICE - Modular approach
router.post(
  "/vaults/:vaultAccountId/transactions",
  validate({
    params: vaultParams, // Only validate params you need
    body: submitTransactionBody, // Only validate body fields you need
  }),
  controller.submitTransaction
);
```

vs.

```typescript
// LESS IDEAL - Combined schema approach (still works, but less flexible)
router.post(
  "/vaults/:vaultAccountId/transactions",
  validate(submitTransactionSchema), // Single schema with nested params/body
  controller.submitTransaction
);
```

## Architecture Overview

### File Structure

```
src/api/validation/
├── schemas.ts      # All validation schemas
├── middleware.ts   # Validation middleware
├── index.ts        # Exports
└── README.md       # This file
```

### How It Works

```
HTTP Request
    ↓
Router with validate() middleware
    ↓
[1] Zod validates params/query/body
    ↓
[2] If valid → transforms data → passes to controller
[3] If invalid → returns 400 with error details
    ↓
Controller (receives validated data)
```

## Usage Examples

### Example 1: Simple Param Validation

```typescript
// Define schema
const vaultParams = z.object({
  vaultAccountId: z.string().min(1, "vaultAccountId is required"),
});

// Use in route
router.get("/vaults/:vaultAccountId", validate({ params: vaultParams }), controller.getVault);
```

### Example 2: Query Parameter Transformation

```typescript
// Schema with transformation
const paginationQuery = z.object({
  limit: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((val) => !isNaN(val) && val > 0, {
      message: "limit must be a positive number",
    }),
  offset: z
    .string()
    .transform((val) => parseInt(val, 10))
    .default("0"),
});

// Use in route
router.get("/items", validate({ query: paginationQuery }), controller.getItems);

// In controller, limit and offset are now numbers!
```

### Example 3: Complex Body Validation

```typescript
// Nested object validation
const createUserBody = z.object({
  username: z.string().min(3).max(20),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
  role: z.enum(["user", "admin", "moderator"]),
  metadata: z
    .object({
      referralCode: z.string().optional(),
      newsletter: z.boolean().default(true),
    })
    .optional(),
});

router.post("/users", validate({ body: createUserBody }), controller.createUser);
```

### Example 4: Multiple Validations

```typescript
// Validate everything
router.post(
  "/vaults/:vaultAccountId/transfer",
  validate({
    params: z.object({
      vaultAccountId: z.string(),
    }),
    query: z.object({
      dryRun: z
        .string()
        .transform((val) => val === "true")
        .optional(),
    }),
    body: z.object({
      amount: z.number().positive(),
      destination: z.string(),
    }),
  }),
  controller.transfer
);
```

## Error Response Format

When validation fails, users receive:

```json
{
  "success": false,
  "error": "Validation failed",
  "statusCode": 400,
  "type": "VALIDATION_ERROR",
  "details": [
    {
      "field": "params.vaultAccountId",
      "message": "vaultAccountId is required",
      "code": "too_small"
    },
    {
      "field": "body.transactionRequest.operation",
      "message": "operation is required",
      "code": "too_small"
    }
  ]
}
```

## Advanced Zod Features

### Custom Validation

```typescript
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((val) => /[A-Z]/.test(val), { message: "Password must contain uppercase letter" })
  .refine((val) => /[0-9]/.test(val), { message: "Password must contain a number" });
```

### Conditional Validation

```typescript
const schema = z
  .object({
    type: z.enum(["email", "phone"]),
    contact: z.string(),
  })
  .refine(
    (data) => {
      if (data.type === "email") {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contact);
      }
      return /^\d{10}$/.test(data.contact);
    },
    {
      message: "Invalid contact format",
      path: ["contact"],
    }
  );
```

### Schema Composition

```typescript
// Base schemas
const timestampFields = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const auditFields = z.object({
  createdBy: z.string(),
  lastModifiedBy: z.string(),
});

// Composed schema
const documentSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
  })
  .merge(timestampFields)
  .merge(auditFields);
```

## Performance Considerations

1. **Schema Reusability** - Define schemas once, reuse everywhere (already implemented)
2. **Async vs Sync** - We use `parseAsync` for consistency, but `parse` is faster if you don't need async
3. **Partial Validation** - Only validate what you need (params, query, OR body)
4. **Bundle Size** - Zod adds ~15KB gzipped (reasonable for the benefits)

## Migration Path

If you need to migrate from the old combined schemas:

```typescript
// OLD WAY (still works, marked as deprecated)
import { getVaultAccountAddressSchema } from "./validation";
router.get("/path", validate(getVaultAccountAddressSchema), handler);

// NEW WAY (recommended)
import { vaultAndAssetParams, indexQuery } from "./validation";
router.get(
  "/path",
  validate({
    params: vaultAndAssetParams,
    query: indexQuery,
  }),
  handler
);
```

## Summary

✅ **Your implementation is following best practices!**

Key takeaways:

- Modular validation (params/query/body separated) ✅
- Zod for TypeScript-first validation ✅
- Middleware pattern for reusability ✅
- Clear error messages with proper status codes ✅
- Type-safe throughout ✅

The only improvement made was splitting the combined schemas into reusable components for better modularity and composition.

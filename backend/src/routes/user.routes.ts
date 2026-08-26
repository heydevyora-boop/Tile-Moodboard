import { Router } from 'express';
import * as userController from '@controllers/user.controller';
import { authenticate, authorize, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import {
  createUserSchema,
  updateUserSchema,
  assignRoleSchema,
  listUsersQuerySchema,
  updateProfileSchema,
  changePasswordSchema,
} from '@validators/user.validators';

const router = Router();

router.use(authenticate);

// ---- Self-service (any authenticated user) — must come before /:id routes ----
router.get('/me', userController.getProfile);
router.patch('/me', validate(updateProfileSchema), userController.updateProfile);
router.post('/me/change-password', validate(changePasswordSchema), userController.changePassword);

// ---- Admin: list / create ----
router.get('/', requirePermission('users:read'), validate(listUsersQuerySchema, 'query'), userController.listUsers);
router.post('/', requirePermission('users:write'), validate(createUserSchema), userController.createUser);

// ---- Admin: single-user operations ----
router.get('/:id', requirePermission('users:read'), userController.getUser);
router.patch('/:id', requirePermission('users:write'), validate(updateUserSchema), userController.updateUser);
router.delete('/:id', requirePermission('users:write'), userController.deleteUser);

// Role assignment is restricted to OWNER specifically — an ADMIN with
// users:write shouldn't be able to grant themselves or others OWNER-level
// access. This is a coarse role gate on top of the permission check above.
router.patch('/:id/role', authorize('OWNER'), validate(assignRoleSchema), userController.assignRole);

export default router;

import { Router } from 'express';
import * as roleController from '@controllers/role.controller';
import { authenticate, authorize, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { updateRoleSchema } from '@validators/role.validators';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('users:read'), roleController.listRoles);
router.patch('/:id', authorize('OWNER'), validate(updateRoleSchema), roleController.updateRole);

export default router;

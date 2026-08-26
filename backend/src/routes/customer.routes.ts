import { Router } from 'express';
import * as customerController from '@controllers/customer.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersQuerySchema,
  addFavoriteSchema,
} from '@validators/customer.validators';

const router = Router();

router.use(authenticate);

router.get('/', requirePermission('customers:read'), validate(listCustomersQuerySchema, 'query'), customerController.list);
router.post('/', requirePermission('customers:write'), validate(createCustomerSchema), customerController.create);

router.get('/:id', requirePermission('customers:read'), customerController.getOne);
router.patch('/:id', requirePermission('customers:write'), validate(updateCustomerSchema), customerController.update);
router.delete('/:id', requirePermission('customers:write'), customerController.remove);

router.get('/:id/history', requirePermission('customers:read'), customerController.history);
router.get('/:id/mood-boards', requirePermission('customers:read'), customerController.moodBoards);

router.get('/:id/favorites', requirePermission('customers:read'), customerController.listFavorites);
router.post('/:id/favorites', requirePermission('customers:write'), validate(addFavoriteSchema), customerController.addFavorite);
router.delete('/:id/favorites/:tileId', requirePermission('customers:write'), customerController.removeFavorite);

export default router;

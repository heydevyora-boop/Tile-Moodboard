import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as roleService from '@services/role.service';
import { UpdateRoleInput } from '@validators/role.validators';

export const listRoles = catchAsync(async (_req: Request, res: Response) => {
  const roles = await roleService.listRoles();
  res.status(200).json({ success: true, data: { roles } });
});

export const updateRole = catchAsync(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  const input = req.body as UpdateRoleInput;
  const role = await roleService.updateRole(req.params.id, input, req.user.id, req);
  res.status(200).json({ success: true, data: { role } });
});

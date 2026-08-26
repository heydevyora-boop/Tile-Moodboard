import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as userService from '@services/user.service';
import {
  CreateUserInput,
  UpdateUserInput,
  AssignRoleInput,
  ListUsersQuery,
  UpdateProfileInput,
  ChangePasswordInput,
} from '@validators/user.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

// ---- Admin ----

export const listUsers = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListUsersQuery;
  const { users, meta } = await userService.listUsers(query);
  res.status(200).json({ success: true, data: { users }, meta });
});

export const getUser = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.getUserById(req.params.id);
  res.status(200).json({ success: true, data: { user } });
});

export const createUser = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as CreateUserInput;
  const user = await userService.createUser(input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { user } });
});

export const updateUser = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdateUserInput;
  const user = await userService.updateUser(req.params.id, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { user } });
});

export const deleteUser = catchAsync(async (req: Request, res: Response) => {
  await userService.deleteUser(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'User deleted' });
});

export const assignRole = catchAsync(async (req: Request, res: Response) => {
  const { roleId } = req.body as AssignRoleInput;
  const user = await userService.assignRole(req.params.id, roleId, requireActorId(req), req);
  res.status(200).json({ success: true, data: { user } });
});

// ---- Self-service ----

export const getProfile = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.getProfile(requireActorId(req));
  res.status(200).json({ success: true, data: { user } });
});

export const updateProfile = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdateProfileInput;
  const user = await userService.updateProfile(requireActorId(req), input, req);
  res.status(200).json({ success: true, data: { user } });
});

export const changePassword = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as ChangePasswordInput;
  await userService.changeOwnPassword(requireActorId(req), input, req);
  res.status(200).json({ success: true, message: 'Password changed. Please log in again.' });
});

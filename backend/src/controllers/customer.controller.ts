import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import * as customerService from '@services/customer.service';
import { CreateCustomerInput, UpdateCustomerInput, ListCustomersQuery, AddFavoriteInput } from '@validators/customer.validators';

function requireActorId(req: Request): string {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user.id;
}

export const create = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as CreateCustomerInput;
  const customer = await customerService.createCustomer(input, requireActorId(req), req);
  res.status(201).json({ success: true, data: { customer } });
});

export const list = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListCustomersQuery;
  const { customers, meta } = await customerService.listCustomers(query);
  res.status(200).json({ success: true, data: { customers }, meta });
});

export const getOne = catchAsync(async (req: Request, res: Response) => {
  const customer = await customerService.getCustomerById(req.params.id);
  res.status(200).json({ success: true, data: { customer } });
});

export const update = catchAsync(async (req: Request, res: Response) => {
  const input = req.body as UpdateCustomerInput;
  const customer = await customerService.updateCustomer(req.params.id, input, requireActorId(req), req);
  res.status(200).json({ success: true, data: { customer } });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
  await customerService.deleteCustomer(req.params.id, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Customer deleted' });
});

export const history = catchAsync(async (req: Request, res: Response) => {
  const moodBoards = await customerService.getCustomerHistory(req.params.id);
  res.status(200).json({ success: true, data: { moodBoards } });
});

export const moodBoards = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as { page?: string; limit?: string };
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 20;
  const { boards, meta } = await customerService.listCustomerMoodBoards(req.params.id, { page, limit });
  res.status(200).json({ success: true, data: { boards }, meta });
});

export const listFavorites = catchAsync(async (req: Request, res: Response) => {
  const favorites = await customerService.listFavorites(req.params.id);
  res.status(200).json({ success: true, data: { favorites } });
});

export const addFavorite = catchAsync(async (req: Request, res: Response) => {
  const { tileId, note } = req.body as AddFavoriteInput;
  const favorite = await customerService.addFavorite(req.params.id, tileId, note, requireActorId(req), req);
  res.status(201).json({ success: true, data: { favorite } });
});

export const removeFavorite = catchAsync(async (req: Request, res: Response) => {
  await customerService.removeFavorite(req.params.id, req.params.tileId, requireActorId(req), req);
  res.status(200).json({ success: true, message: 'Favorite removed' });
});

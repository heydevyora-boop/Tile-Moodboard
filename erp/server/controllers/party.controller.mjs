import { parse, handler } from '../validate.mjs';
import { PartySearchQuery, PartyTypeParam, PartyHistoryQuery } from '../validators/party.validator.mjs';
import * as party from '../services/party.service.mjs';

/* ============================================================
   PARTY CONTROLLER
   ============================================================
   HTTP in, HTTP out. party.service.mjs itself just dispatches to
   customer.service.mjs / supplier.service.mjs -- nothing about a
   customer or a supplier is decided here or in that service; this
   is a search surface over the two, not a third source of truth.
   ============================================================ */

export const search = handler(async (req, res) => {
  const query = parse(PartySearchQuery, req.query);
  res.json(await party.search(query));
});

export const get = handler(async (req, res) => {
  const partyType = parse(PartyTypeParam, req.params.partyType);
  res.json(await party.get(partyType, req.params.id));
});

export const history = handler(async (req, res) => {
  const partyType = parse(PartyTypeParam, req.params.partyType);
  const query = parse(PartyHistoryQuery, req.query);
  res.json(await party.history(partyType, req.params.id, query));
});

import { createApp } from './app.mjs';

const port = Number(process.env.ERP_API_PORT) || 4310;
const host = process.env.ERP_API_HOST || '127.0.0.1';

/* Bound to the loopback interface by default. The ERP API is for
   the ERP frontend; it has no authentication yet and must not be
   reachable from the network until it does. */
createApp().listen(port, host, () => {
  console.log('ERP Product Master API on http://' + host + ':' + port);
});

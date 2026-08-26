import morgan from 'morgan';
import { httpLogStream } from '@utils/logger';
import { config } from '@config/index';

// Dev: concise colored one-liner. Prod: detailed line (still one-liner) for
// log aggregation, piped through winston so it lands in the same files.
const format = config.isDev ? 'dev' : 'combined';

export const requestLogger = morgan(format, { stream: httpLogStream });

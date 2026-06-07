import http from 'http';
import os from 'node:os';
import { Express } from 'express';
import Env from './shared/utils/env';
import { db } from './config/database';
import app from './config/express';
import { AppEnv } from './shared/enums';
import { envValidatorSchema } from './shared/validators/env-validator';
import config from './config/env';

function listenOnce(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // 0.0.0.0 so phones on the same LAN can reach this Mac (not only 127.0.0.1).
    server.listen(port, '0.0.0.0');
  });
}

function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    if (!nets) continue;
    for (const n of nets) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

async function main(app: Express): Promise<void> {
  await Env.validateEnv(envValidatorSchema);
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);
  if (Env.get<string>('NODE_ENV') === AppEnv.PRODUCTION || onRailway) {
    app.set('trust proxy', 1);
  }
  await db.connect();

  const jwtTtl = config?.JWT_TIME_TO_LIVE?.trim() || '30d (default)';
  console.log(`Auth JWT time-to-live: ${jwtTtl}`);

  const {
    syncWalletExchangeRatesFromMarket,
    startWalletFxSyncScheduler,
  } = await import('./modules/payment/fxRateSyncService');
  await syncWalletExchangeRatesFromMarket();
  startWalletFxSyncScheduler();

  const { startDayflowAutopayScheduler } = await import(
    './modules/dayflow/dayflowAutomationService'
  );
  startDayflowAutopayScheduler();

  const { startBudgetReminderScheduler } = await import(
    './modules/payment/budgetReminderScheduler'
  );
  startBudgetReminderScheduler();

  const server = http.createServer(app);

  const preferredPort = Number(Env.get('PORT') ?? 3000);
  const NODE_ENV = Env.get<string>('NODE_ENV');
  const maxPort =
    NODE_ENV === AppEnv.DEVELOPMENT ? preferredPort + 25 : preferredPort;

  for (let port = preferredPort; port <= maxPort; port++) {
    try {
      await listenOnce(server, port);
      if (port !== preferredPort && NODE_ENV === AppEnv.DEVELOPMENT) {
        console.warn(
          `Port ${preferredPort} was in use; using ${port}. Set DAYFI_PORT=${port} in .env and your Flutter baseUrl to keep this port.`
        );
      }
      if (NODE_ENV !== AppEnv.PRODUCTION && !onRailway) {
        console.log(`Listening on http://0.0.0.0:${port} (simulator: http://127.0.0.1:${port})`);
        const lan = lanIPv4Addresses();
        if (lan.length) {
          console.log(
            `Physical device (same Wi‑Fi): set Flutter --dart-define=DAYFI_API_HOST=${lan[0]} (or ${lan.join('/')}) → http://${lan[0]}:${port}/api/v1`
          );
        }
      }
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE' && NODE_ENV === AppEnv.DEVELOPMENT && port < maxPort) {
        continue;
      }
      if (code === 'EADDRINUSE') {
        console.error(
          `Port ${port} is already in use. Stop the other process (e.g. \`lsof -i :${port}\` then kill that PID), or set DAYFI_PORT in .env to a free port (and match your Flutter baseUrl).`
        );
      }
      throw err;
    }
  }
}

main(app);

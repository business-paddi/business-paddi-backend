// Run from the deployment working directory. Does not connect to the database.
require('dotenv/config');
const express = require('express');
const maxmind = require('maxmind');
const net = require('node:net');
const path = require('node:path');

async function main() {
  const databasePath = path.resolve(
    process.env.MAXMIND_DB_PATH || 'data/GeoLite2-City.mmdb',
  );
  const database = await maxmind.open(databasePath);
  console.log(JSON.stringify({ databasePath, metadata: database.metadata }));
  const app = express();
  const trust = process.env.TRUST_PROXY || '1';
  app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);
  const examples = process.argv.length > 2
    ? [{ forwardedFor: process.argv[2], peer: process.argv[3] || '10.0.0.10' }]
    : [
        { forwardedFor: '197.210.29.1', peer: '10.0.0.10' },
        { forwardedFor: '197.210.29.1, 10.0.0.5', peer: '10.0.0.10' },
        { forwardedFor: '197.210.29.1:54321', peer: '10.0.0.10' },
      ];
  for (const { forwardedFor, peer } of examples) {
    const request = Object.create(app.request);
    request.app = app;
    request.socket = { remoteAddress: peer };
    request.headers = { 'x-forwarded-for': forwardedFor };
    const ip = request.ip.replace(/^::ffff:/i, '').split('%')[0];
    const result = net.isIP(ip) ? database.get(ip) : null;
    console.log(JSON.stringify({
      trustProxy: trust, peer, forwardedFor, resolvedIp: request.ip,
      validIp: Boolean(net.isIP(ip)),
      city: result?.city?.names?.en ?? null,
      region: result?.subdivisions?.[0]?.names?.en ?? null,
      country: result?.country?.names?.en ?? null,
    }));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

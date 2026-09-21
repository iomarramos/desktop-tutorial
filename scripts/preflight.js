#!/usr/bin/env node
const { validateProductionConfig } = require('../config/productionReadiness');

const strictIntegrations = process.argv.includes('--strict-integrations');
const result = validateProductionConfig(process.env, { strictIntegrations });

console.log('DESENCAJADO — comprobación previa a producción');
for (const [name, ready] of Object.entries(result.integrations)) {
  console.log(`${ready ? '✓' : '○'} ${name}`);
}
for (const warning of result.warnings) console.warn(`ADVERTENCIA: ${warning}`);
for (const blocker of result.blockers) console.error(`BLOQUEO: ${blocker}`);

if (!result.ok) process.exitCode = 1;

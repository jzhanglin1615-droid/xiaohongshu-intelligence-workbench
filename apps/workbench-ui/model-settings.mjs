import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const defaultModelSettings = () => ({ schemaVersion: 1, apiEnabled: false, providers: {} });

export async function readModelSettings(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8'));
    return { ...defaultModelSettings(), ...value, providers: value.providers && typeof value.providers === 'object' ? value.providers : {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultModelSettings();
    throw error;
  }
}

export async function writeModelSettings(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export function transformSecret(scriptPath, action, value) {
  if (process.platform !== 'win32') throw new Error('MODEL_SECRET_STORAGE_WINDOWS_ONLY');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(scriptPath), '-Action', action], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`MODEL_SECRET_STORAGE_FAILED:${code}`)));
    child.stdin.end(value, 'utf8');
  });
}

export async function restoreModelSecrets(settings, providers, scriptPath, environment = process.env) {
  let changed = false;
  for (const provider of providers) {
    const saved = settings.providers[provider.providerId];
    if (saved?.cleared) { delete environment[provider.apiKeyEnv]; continue; }
    if (saved?.encryptedKey) {
      environment[provider.apiKeyEnv] = await transformSecret(scriptPath, 'Unprotect', saved.encryptedKey);
      continue;
    }
    const inheritedKey = environment[provider.apiKeyEnv]?.trim();
    if (!inheritedKey) continue;
    settings.providers[provider.providerId] = { ...saved, baseUrl: saved?.baseUrl ?? provider.baseUrl, encryptedKey: await transformSecret(scriptPath, 'Protect', inheritedKey), cleared: false };
    changed = true;
  }
  return changed;
}

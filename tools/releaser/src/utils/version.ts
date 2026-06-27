import chalk from 'chalk';
import * as semver from 'semver';

/**
 * Sanitizes a version string by removing any leading 'v' if present.
 * Warns the user if the input contained a leading 'v'.
 *
 * @param version The version string to sanitize
 * @returns The sanitized version string
 */
export function sanitizeVersion(version: string): string {
  if (version.startsWith('v')) {
    const sanitized = version.substring(1);
    console.log(chalk.yellow(`Warning: Version "${version}" contains a leading 'v'. The 'v' prefix has been removed.`));
    console.log(chalk.yellow(`Using version "${sanitized}" instead.`));
    return sanitized;
  }
  return version;
}

/**
 * Validates if a version string is a strict semantic version.
 * Allows standard semver (e.g. 0.24.0) and prerelease versions (e.g. 0.24.0-rc1).
 *
 * @param version The version string to validate
 * @returns True if valid, false otherwise
 */
export function isValidVersion(version: string): boolean {
  const trimmed = version.trim();
  if (trimmed.startsWith('v')) {
    return false;
  }
  return semver.valid(trimmed) !== null;
}

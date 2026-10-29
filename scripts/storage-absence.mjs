// Storage exists() intentionally returns data:false WITH a StorageError for missing HEADs.
export function objectIsAbsent(result) {
  if (result.data !== false) return false;
  if (!result.error) return true;
  const status = result.error.status ?? result.error.originalError?.status;
  return status === 400 || status === 404;
}

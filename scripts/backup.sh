#!/bin/bash
set -euo pipefail

##
## SQL Server Database Backup Script
##
## Purpose:
##   Performs a full BACKUP DATABASE operation on the knowledge_e3 database
##   and stores the backup file on a different volume for off-host safety.
##
## Prerequisites:
##   - SQL Server is running and accessible at the server/port specified
##   - The 'sa' user has credentials set in environment or passed as arguments
##   - The backup directory exists and is writable
##   - sqlcmd tool is installed and in PATH
##
## Usage:
##   ./backup.sh [SERVER] [USERNAME] [PASSWORD] [BACKUP_PATH]
##
## Environment variables (alternative to arguments):
##   - MSSQL_SERVER: SQL Server instance (default: localhost)
##   - MSSQL_USER: Username for authentication (default: sa)
##   - MSSQL_PASSWORD: Password for authentication (required if not passed)
##   - BACKUP_BASE_PATH: Directory to store backup files (default: /var/opt/mssql/backup)
##

# Configuration with defaults
MSSQL_SERVER="${1:-${MSSQL_SERVER:-localhost}}"
MSSQL_USER="${2:-${MSSQL_USER:-sa}}"
MSSQL_PASSWORD="${3:-${MSSQL_PASSWORD:?Error: MSSQL_PASSWORD not set}}"
BACKUP_BASE_PATH="${4:-${BACKUP_BASE_PATH:-/var/opt/mssql/backup}}"

DB_NAME="knowledge_e3"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_BASE_PATH}/${DB_NAME}_${TIMESTAMP}.bak"

echo "Starting backup of database: ${DB_NAME}"
echo "Server: ${MSSQL_SERVER}"
echo "Backup destination: ${BACKUP_FILE}"
echo "Started at: $(date --iso-8601=seconds)"

# Create backup directory if it doesn't exist
mkdir -p "${BACKUP_BASE_PATH}"

# Run the backup command.
# WITH CHECKSUM makes SQL Server compute and store page checksums during the
# backup so corruption can be detected on restore/verify.
sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -Q "BACKUP DATABASE [${DB_NAME}] TO DISK = N'${BACKUP_FILE}' WITH NOFORMAT, NOINIT, NAME = N'${DB_NAME}-Full Database Backup', SKIP, NOREWIND, NOUNLOAD, CHECKSUM, STATS = 10;" \
  -b

# Verify the backup file was created.
if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file was not created"
  exit 1
fi

# Integrity gate: a file existing is NOT proof of a usable backup. RESTORE
# VERIFYONLY ... WITH CHECKSUM re-reads the media and validates the stored
# checksums without touching the live database. Fail loudly if it doesn't pass.
echo "Verifying backup integrity (RESTORE VERIFYONLY WITH CHECKSUM)..."
if ! sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -b \
  -Q "RESTORE VERIFYONLY FROM DISK = N'${BACKUP_FILE}' WITH CHECKSUM;"; then
  echo "ERROR: Backup verification FAILED — the backup file is not restorable. Deleting corrupt artifact."
  rm -f "${BACKUP_FILE}"
  exit 1
fi

FILE_SIZE=$(stat -f%z "${BACKUP_FILE}" 2>/dev/null || stat -c%s "${BACKUP_FILE}" 2>/dev/null || echo "unknown")
echo "Backup successful and verified!"
echo "Backup file: ${BACKUP_FILE}"
echo "File size: ${FILE_SIZE} bytes"
echo "Completed at: $(date --iso-8601=seconds)"
exit 0

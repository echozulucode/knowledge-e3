#!/bin/bash
set -euo pipefail

##
## SQL Server Restore Drill Script
##
## Purpose:
##   Performs a full restore of the latest database backup into a temporary
##   database, runs smoke tests to verify data integrity, then drops the
##   temporary database. Exits 0 on success, non-zero on failure.
##
## Prerequisites:
##   - SQL Server is running and accessible
##   - At least one backup file exists (typically created by backup.sh)
##   - The 'sa' user has credentials set in environment or passed as arguments
##   - sqlcmd tool is installed and in PATH
##
## Usage:
##   ./restore-drill.sh [SERVER] [USERNAME] [PASSWORD] [BACKUP_PATH]
##
## Environment variables (alternative to arguments):
##   - MSSQL_SERVER: SQL Server instance (default: localhost)
##   - MSSQL_USER: Username for authentication (default: sa)
##   - MSSQL_PASSWORD: Password for authentication (required if not passed)
##   - BACKUP_BASE_PATH: Directory containing backup files (default: /var/opt/mssql/backup)
##
## Run schedule:
##   Designed to be executed monthly via cron or Windows scheduled task.
##   Example cron entry: 0 2 1 * * /path/to/restore-drill.sh
##

# Configuration with defaults
MSSQL_SERVER="${1:-${MSSQL_SERVER:-localhost}}"
MSSQL_USER="${2:-${MSSQL_USER:-sa}}"
MSSQL_PASSWORD="${3:-${MSSQL_PASSWORD:?Error: MSSQL_PASSWORD not set}}"
BACKUP_BASE_PATH="${4:-${BACKUP_BASE_PATH:-/var/opt/mssql/backup}}"

DB_NAME="knowledge_e3"
TEST_DB_NAME="${DB_NAME}_restore_test_$$"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="/var/log/knowledge-e3/restore-drill-${TIMESTAMP}.log"

# Create log directory if needed
mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true

# Helper function for logging
log() {
  echo "[$(date --iso-8601=seconds)] $1" | tee -a "${LOG_FILE}"
}

# Assert a captured value is a non-negative integer and at least `min`.
# Guards against sqlcmd emitting an error string where we expected a count.
assert_min() {
  local label="$1" value="$2" min="$3"
  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    log "ERROR: ${label} is not a numeric count (got: '${value}') — restore drill FAILED"
    exit 1
  fi
  if [ "${value}" -lt "${min}" ]; then
    log "ERROR: ${label} (${value}) is below the expected minimum (${min}) — restore drill FAILED"
    exit 1
  fi
  log "OK: ${label} = ${value} (>= ${min})"
}

cleanup() {
  log "Cleaning up temporary database: ${TEST_DB_NAME}"
  sqlcmd \
    -S "${MSSQL_SERVER}" \
    -U "${MSSQL_USER}" \
    -P "${MSSQL_PASSWORD}" \
    -Q "DROP DATABASE IF EXISTS [${TEST_DB_NAME}];" \
    -b 2>&1 | tee -a "${LOG_FILE}" || true
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

log "=== Restore Drill Started ==="
log "Server: ${MSSQL_SERVER}"
log "Database: ${DB_NAME}"
log "Test database: ${TEST_DB_NAME}"
log "Backup path: ${BACKUP_BASE_PATH}"

# Find the most recent backup file
LATEST_BACKUP=$(ls -t "${BACKUP_BASE_PATH}"/${DB_NAME}_*.bak 2>/dev/null | head -1)

if [ -z "${LATEST_BACKUP}" ]; then
  log "ERROR: No backup files found in ${BACKUP_BASE_PATH}"
  exit 1
fi

log "Found backup: ${LATEST_BACKUP}"
BACKUP_SIZE=$(stat -f%z "${LATEST_BACKUP}" 2>/dev/null || stat -c%s "${LATEST_BACKUP}" 2>/dev/null || echo "unknown")
log "Backup size: ${BACKUP_SIZE} bytes"

# Step 0: Verify the backup media before trusting it.
log "Step 0: Verifying backup media (RESTORE VERIFYONLY WITH CHECKSUM)..."
sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -Q "RESTORE VERIFYONLY FROM DISK = N'${LATEST_BACKUP}' WITH CHECKSUM;" \
  -b 2>&1 | tee -a "${LOG_FILE}"

# Step 1: Restore to temporary database
log "Step 1: Restoring backup to temporary database..."
sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -Q "RESTORE DATABASE [${TEST_DB_NAME}] FROM DISK = N'${LATEST_BACKUP}' WITH REPLACE, RECOVERY;" \
  -b 2>&1 | tee -a "${LOG_FILE}"

log "Restore completed."

# Step 2: Run smoke tests on restored database
log "Step 2: Running smoke tests on restored database..."

# Test: Can we connect to the database?
log "Test 2.1: Database connectivity..."
sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -d "${TEST_DB_NAME}" \
  -Q "SELECT @@VERSION;" \
  -b 2>&1 | tee -a "${LOG_FILE}"

# Test: Does the pages table exist and have data?
log "Test 2.2: Verifying pages table..."
PAGE_COUNT=$(sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -d "${TEST_DB_NAME}" \
  -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM pages;" \
  -h -1 2>>"${LOG_FILE}" | xargs)

log "Page count in restored database: ${PAGE_COUNT}"

# Test: Does the users table exist?
log "Test 2.3: Verifying users table..."
USER_COUNT=$(sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -d "${TEST_DB_NAME}" \
  -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM users;" \
  -h -1 2>>"${LOG_FILE}" | xargs)

log "User count in restored database: ${USER_COUNT}"

# Test: Does the page_versions table exist?
log "Test 2.4: Verifying page_versions table..."
VERSION_COUNT=$(sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -d "${TEST_DB_NAME}" \
  -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM page_versions;" \
  -h -1 2>>"${LOG_FILE}" | xargs)

log "Version count in restored database: ${VERSION_COUNT}"

# Test: Run a sample query (e.g., find pages updated in the last 7 days)
log "Test 2.5: Running sample query (pages updated in last 7 days)..."
RECENT_COUNT=$(sqlcmd \
  -S "${MSSQL_SERVER}" \
  -U "${MSSQL_USER}" \
  -P "${MSSQL_PASSWORD}" \
  -d "${TEST_DB_NAME}" \
  -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND updated_at >= DATEADD(day, -7, GETUTCDATE());" \
  -h -1 2>>"${LOG_FILE}" | xargs)

log "Recently updated pages: ${RECENT_COUNT}"

# Step 3: ASSERT the smoke-test results. Logging counts is not verification —
# a restore that produced 0 rows, or a captured sqlcmd error string, must fail
# the drill. A healthy restore has at least the bootstrap admin user and at
# least one page version per page.
log "Step 3: Asserting restored row counts..."
assert_min "pages" "${PAGE_COUNT}" 0
assert_min "users" "${USER_COUNT}" 1
assert_min "page_versions" "${VERSION_COUNT}" "${PAGE_COUNT}"
assert_min "recently_updated_pages" "${RECENT_COUNT}" 0

log "=== All Smoke Tests Passed ==="
log "Restore drill completed successfully."
log "Test database will be dropped on exit."

exit 0

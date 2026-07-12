---
title: Production Incident Runbook
status: published
tags: [runbook, incident-response, production]
owner: alice
created_at: 2026-04-15
updated_at: 2026-04-28
authors: [alice, bob, charlie]
runbook_id: INC-2026-PROD-001
---

# Production Incident Response Runbook

## Purpose

This runbook provides step-by-step procedures for responding to critical production incidents involving database connectivity, application crashes, or performance degradation.

## Quick Reference

| Severity | Response Time | Escalation |
|----------|---|---|
| Critical (P1) | 5 minutes | VP Engineering + On-call |
| High (P2) | 30 minutes | Engineering Lead + On-call |
| Medium (P3) | 2 hours | Engineering Lead |
| Low (P4) | Next business day | Backlog |

## Incident Detection

We detect incidents through:

- 🔴 Critical Sentry alerts (p95 latency > 5s, error rate > 5%)
- 📊 Datadog dashboard anomalies
- 👥 User reports via [[Support Queue]]
- 🔗 Automated health checks
  - Database connectivity tests every 30 seconds
  - API endpoint checks every 60 seconds
  - Cache layer verification every 10 seconds

## Initial Response (First 5 minutes)

1. **Acknowledge the alert**
   - Page acknowledges on-call engineer
   - On-call joins war room bridge
   - Scribe starts transcript logging

2. **Gather context**
   - Check [[Recent Deployments]] for last 2 hours
   - Review [[Database Query Performance]] metrics
   - Examine [[Application Error Logs]] for patterns

3. **Determine blast radius**
   - [ ] Is it regional or global?
   - [ ] Affects web, API, or both?
   - [ ] User impact: percentage and business impact?

## Investigation (Minutes 5–15)

A prioritized investigation sequence:

1. First check recent changes
   ```javascript
   // Query recent deployments
   SELECT * FROM deployments 
   WHERE created_at > NOW() - INTERVAL 2 HOUR
   ORDER BY created_at DESC;
   ```

2. Then check error logs
   ```
   tail -f /var/log/app/error.log | grep -i "exception\|failed\|timeout"
   ```

3. Verify database connection pool
   - Max connections: 100
   - Current active: check `sp_who2`
   - Blocked queries: investigate locks

4. Check infrastructure
   - CPU usage across fleet (target: <70%)
   - Memory usage (target: <80%)
   - Disk I/O latency
   - Network bandwidth saturation

## Common Scenarios

### Scenario A: Database Connection Exhaustion

**Symptoms:** Application logs show "connection pool exhausted" or "unable to acquire connection"

**Resolution:**
- Verify max_connections in [[Database Configuration]]
- Check for hanging transactions: `SELECT * FROM sys.dm_exec_sessions WHERE status = 'sleeping'`
- Restart connection pool on affected app servers
- If persistent, trigger database failover to standby

**Mitigation:** Scale read replicas, enable query caching

### Scenario B: Memory Leak in Worker Processes

**Symptoms:** Memory usage grows monotonically, process restarts help temporarily

**Resolution:**
- Identify leaking process via memory profiler
- Review recent code changes affecting that component
- Deploy fix with feature flag disabled initially
- Monitor memory baseline after restart

**Escalation:** [[Platform Team]] for process analysis

### Scenario C: Upstream API Dependency Failure

**Symptoms:** Downstream services timeout; upstream shows 502/503 errors

**Resolution:**
- Verify upstream service status via [[Upstream Dashboard]]
- If upstream is down, activate circuit breaker for graceful degradation
- Route requests to cache or fallback service
- Page upstream on-call if SLA breach imminent
- Update [[Status Page]] with customer notification

## Recovery Steps

1. **Restore service** (in order of priority):
   - API endpoints (affects external integrations)
   - Web frontend (affects internal users)
   - Background workers (affects data pipelines)

2. **Verify recovery**:
   - Check error rate trending to baseline
   - Verify p95 latency < 2s
   - Spot-check 3 different user workflows

3. **Communicate status**:
   - Post all-clear to [[Slack #incident-response]]
   - Update [[Status Page]] with resolution timestamp
   - Email affected customers (if applicable)

## Post-Incident (Within 24 hours)

1. **Write incident summary** in [[Incident Archive]]:
   - Timeline of events
   - Root cause identified
   - Immediate fixes applied
   - Permanent fixes planned

2. **Assign action items**:
   ```
   - [ ] Action: Implement database connection pooling alerts
     Owner: @bob
     Target: 2026-05-05
   
   - [ ] Action: Add circuit breaker for upstream API
     Owner: @charlie
     Target: 2026-05-10
   ```

3. **Schedule blameless post-mortem**:
   - Invite all responders plus [[Engineering Leadership]]
   - Focus on system failures, not human error
   - Document systemic improvements

## Links and Resources

- **Dashboards:** [[Datadog Production Dashboard]]
- **Documentation:** [[Infrastructure Architecture]]
- **Contacts:** [[On-call Rotation Schedule]]
- **Previous incidents:** [[Incident Archive]]
- **Status:** [[Public Status Page]]

---

**Last Updated:** 2026-04-28
**Version:** 2.1
**Next Review:** 2026-05-28

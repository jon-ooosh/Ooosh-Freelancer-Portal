# Traccar on PostgreSQL — runbook (Oct 2026)

Traccar (the GPS tracking server, `tracking.oooshtours.co.uk`, Docker container
`traccar` on the OP server) moves from its built-in H2 database to OP's
PostgreSQL 16, in its own database and login. Why: H2 is "not recommended for
production" (Traccar's own docs), it can't be backed up while running, and on 12
Oct 2026 it — and Traccar's config — lived only inside the container, so
recreating the container would have wiped 8 months of history.

After this:
- Traccar's data is in PostgreSQL database `traccar` (login `traccar`), its config
  at `/opt/traccar/conf/traccar.xml` on the server, its logs at `/opt/traccar/logs`.
- The image is pinned as `ooosh/traccar:6.11.1` — never run `traccar/traccar:latest`
  against this database without upgrading deliberately (a newer Traccar migrates
  the schema forward; there is no way back).
- OP's scheduler, 03:10 UK nightly (`backend/src/scripts/traccar-backup.ts`):
  deletes positions older than 12 months (each van's current position is never
  deleted), `pg_dump`s the database live (no downtime) to R2
  `backups/traccar/*.dump`, keeps the 7 newest + the newest of the 4 weeks before.
  Off until `TRACCAR_DATABASE_URL` is in `backend/.env`.

The copy itself is `deploy/traccar/h2-to-postgres.sh`: it streams every H2 table
into the Traccar-created PostgreSQL schema through named pipes (no multi-GB CSV on
disk), resets the id sequences and refuses to finish unless every table's row count
matches. Rehearsed against Traccar 6.11.1 with 1.8M positions: all 48 tables,
binary keys, quoted/multi-line text and NULLs byte-identical; Traccar then logged
in, served trips and routes, and carried on numbering new positions.

Facts this was planned on (12 Oct 2026): Traccar 6.11.1, image
`sha256:8d2b81a2ff2a…`, H2 data 3.4GB (808MB gzipped), 2 CPUs, 3.7GB RAM, no swap,
20GB free disk, PostgreSQL 16 listening on localhost only, Docker bridge
`172.17.0.1/16`, ufw active (22, 80, 443, 5027 open).

---

## Phase 1 — prep (daytime; OP blinks for a few seconds)

Run as root. Each block is safe to re-run (1b just reports "already exists" the second time).

**1a. Pin the image the live container is running.**
```bash
docker tag "$(docker inspect traccar --format '{{.Image}}')" ooosh/traccar:6.11.1
docker image inspect ooosh/traccar:6.11.1 --format '{{.Id}}'   # expect sha256:8d2b81a2ff2a…
```

**1b. A database and login for Traccar.** The password is generated and kept in a root-only file.
```bash
[ -f /root/traccar-db-password ] || (umask 077; openssl rand -hex 24 > /root/traccar-db-password)
sudo -u postgres psql -c "CREATE ROLE traccar LOGIN PASSWORD '$(cat /root/traccar-db-password)'"
sudo -u postgres psql -c "CREATE DATABASE traccar OWNER traccar"
```

**1c. Let the Docker container reach PostgreSQL.** PostgreSQL listens on all
addresses (so it still works if it starts before Docker after a reboot); who may
connect is still limited by `pg_hba.conf` (Traccar's login, from Docker's network
only) and by the firewall (5432 stays closed to the internet).
```bash
ufw status verbose | grep Default        # must say: deny (incoming)
PGCONF=$(sudo -u postgres psql -Atc "show config_file")
PGHBA=$(sudo -u postgres psql -Atc "show hba_file")
cp "$PGCONF" "$PGCONF.bak-2026-10" && cp "$PGHBA" "$PGHBA.bak-2026-10"
grep -q "^listen_addresses = '\*'" "$PGCONF" || echo "listen_addresses = '*'   # Traccar in Docker (docs/TRACCAR-POSTGRES.md)" >> "$PGCONF"
grep -q "^host traccar traccar 172.17.0.0/16" "$PGHBA" || echo "host traccar traccar 172.17.0.0/16 scram-sha-256" >> "$PGHBA"
ufw allow from 172.17.0.0/16 to any port 5432 proto tcp comment 'Traccar container to PostgreSQL'
systemctl restart postgresql && sleep 2 && systemctl restart ooosh-portal
sudo -u postgres psql -Atc "show listen_addresses"     # *
systemctl status ooosh-portal --no-pager | head -5      # active (running)
```

**1d. Traccar's config on the server's disk.**
```bash
mkdir -p /opt/traccar/conf
umask 077; cat > /opt/traccar/conf/traccar.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE properties SYSTEM 'http://java.sun.com/dtd/properties.dtd'>
<properties>
    <!-- Documentation: https://www.traccar.org/configuration-file/ -->
    <entry key='database.driver'>org.postgresql.Driver</entry>
    <entry key='database.url'>jdbc:postgresql://172.17.0.1:5432/traccar</entry>
    <entry key='database.user'>traccar</entry>
    <entry key='database.password'>$(cat /root/traccar-db-password)</entry>
    <!-- Drop no-fix (0,0) positions — the RO23HLU "in the sea" bug -->
    <entry key='filter.enable'>true</entry>
    <entry key='filter.zero'>true</entry>
</properties>
EOF
umask 022; grep -c entry /opt/traccar/conf/traccar.xml    # 6
```

## Phase 2 — rehearsal (daytime; live Traccar untouched)

A second Traccar, on a private port, against the new database, filled from the 12
Oct backup copy.

```bash
# 2a. Traccar builds its own tables in the empty database, then stops.
docker run -d --name traccar-pg-test -p 127.0.0.1:8083:8082 \
  -v /opt/traccar/conf/traccar.xml:/opt/traccar/conf/traccar.xml:ro ooosh/traccar:6.11.1
sleep 60; docker logs --tail 15 traccar-pg-test     # an UPDATE SUMMARY, no ERROR / Exception
docker stop traccar-pg-test

# 2b. Copy the 12 Oct H2 backup into it.
cd /var/www/ooosh-portal
time H2_DIR=/root/traccar-data-2026-10-12 bash deploy/traccar/h2-to-postgres.sh
#    Must end: "All 48 tables copied; every row count matches." Note how long it took.

# 2c. Start the test Traccar on the copy and ask it questions with YOUR Traccar login.
docker start traccar-pg-test; sleep 45
TA='YOUR_TRACCAR_EMAIL:YOUR_TRACCAR_PASSWORD'
curl -s -u "$TA" localhost:8083/api/devices | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d), 'devices'); [print('RO23HLU is device', x['id']) for x in d if x['uniqueId']=='864022082913707']"
curl -s -u "$TA" -H 'Accept: application/json' "localhost:8083/api/reports/trips?deviceId=DEVICE_ID_FROM_ABOVE&from=2026-10-01T00:00:00Z&to=2026-10-12T00:00:00Z" | python3 -c "import json,sys; print(len(json.load(sys.stdin)), 'trips, 1-12 Oct')"
sudo -u postgres psql -d traccar -Atc "select pg_size_pretty(pg_database_size('traccar'))"
df -h /

# 2d. Done with it.
docker rm -f traccar-pg-test
```
Send the outputs of 2b–2c. If anything doesn't match, stop — nothing live has changed.

## Phase 3 — switch-over (scheduled, unattended, ~04:30 UK; Traccar offline ~8–10 min)

Rehearsal on 12 Oct 2026: 7,420,242 positions, 676,066 events, 23 devices; the copy
took 4 minutes; Traccar on the copy logged in and found RO23HLU's trips; the
database is 3.8GB. Trackers keep their positions while the server is down and send
them when it is back.

`deploy/traccar/switch-to-postgres.sh` does the whole switch and logs every step to
`/root/traccar-switch.log`. It checks everything before touching Traccar (and
changes nothing if a check fails), stops the old Traccar, copies its data out, runs
`h2-to-postgres.sh` (starting the old Traccar again if the copy fails), starts the
new one, and — if it hasn't answered within 3 minutes — removes it and puts the old
one back. It refuses to run twice. Tested end to end, including the roll-back.

Schedule it (the evening before):
```bash
systemd-analyze calendar '2026-10-13 04:30:00 Europe/London'   # check "Next elapse"
systemd-run --unit traccar-switch --on-calendar='2026-10-13 04:30:00 Europe/London' \
  /bin/bash /var/www/ooosh-portal/deploy/traccar/switch-to-postgres.sh
systemctl list-timers traccar-switch.timer                       # shows it waiting
```
Cancel before it runs: `systemctl stop traccar-switch.timer`.

**Undo after a completed switch** (positions since the switch are lost from view, nothing else):
```bash
docker rm -f traccar
docker rename traccar-h2-old traccar
docker update --restart=always traccar
docker start traccar
```

## Phase 4 — morning checks (~07:00)

0. `tail -30 /root/traccar-switch.log` — ends `SWITCH COMPLETE`. (If it says `ROLLED BACK`
   or `STOPPED`, the old Traccar is running as before — send the log.)
1. `docker ps -a --filter name=traccar` — `traccar` Up; `traccar-h2-old` Exited (`-a` lists stopped containers too).
2. Traccar web (`tracking.oooshtours.co.uk`): log in; vans online; RO23HLU's route
   for yesterday shows, AND positions from after 04:30 (proves new data lands).
3. OP › Vehicles › Fleet Map: vans on the map; a van's Location tab shows Recent Trips.
4. `docker logs --since 3h traccar 2>&1 | grep -i -E "error|exception" | tail` — nothing alarming
   (an occasional geocoder 429 is harmless).

## Phase 5 — switch on the nightly backup (after the morning checks)

```bash
cd /var/www/ooosh-portal/backend
grep -q '^TRACCAR_DATABASE_URL=' .env || \
  echo "TRACCAR_DATABASE_URL=postgresql://traccar:$(cat /root/traccar-db-password)@localhost:5432/traccar" >> .env
sudo systemctl restart ooosh-portal
journalctl -u ooosh-portal -n 80 --no-pager | grep -i traccar   # "Traccar backup + 12-month purge scheduled daily at 03:10"
time node dist/scripts/traccar-backup.js    # one by hand now: "uploaded backups/traccar/… (NNNMB)"
```
Afterwards it runs every night at 03:10 and logs `Scheduler: Traccar backup complete — …`
(the Monday maintenance report's backup section picks that line up).

## Phase 6 — tidy up (two weeks later, if all is well)

```bash
docker rm traccar-h2-old
rm -rf /root/traccar-data-2026-10-12 /root/traccar-data-final /root/traccar.xml /root/traccar.xml.bak-2026-10-12 /var/tmp/traccar-migrate
```

---

## Restoring from a backup

```bash
# Fetch the .dump from R2 (backups/traccar/), then:
docker stop traccar
sudo -u postgres dropdb traccar && sudo -u postgres createdb -O traccar traccar
sudo -u postgres pg_restore --no-owner --role=traccar -d traccar /path/to/traccar-….dump
docker start traccar
```

## Upgrading Traccar later

Take a fresh backup first (`node dist/scripts/traccar-backup.js`), pull the new
version's tag explicitly (`docker pull traccar/traccar:X.Y.Z`), and recreate the
container from it with the same `docker run` line as step 3 of `deploy/traccar/switch-to-postgres.sh`. Traccar upgrades the
schema itself on start; it can't be downgraded, so the backup is the way back.

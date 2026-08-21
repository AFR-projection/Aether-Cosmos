# 🔧 Troubleshooting

Common issues and solutions.

---

## Local Development

**Redis connection error**
- Set `REDIS_DISABLED=true` in `.env`
- Or start Redis: `docker compose -f docker/docker-compose.dev.yml up -d`

**Upload fails / CORS error**
- Configure R2 CORS using `docker/r2-cors.json`
- Ensure `AllowedOrigins` includes your dev URL

**Worker cannot connect to Redis**
- Hostname `redis` is Docker-only
- Locally: set `REDIS_DISABLED=true` and skip worker

---

## Production

**SSL certificate issues**
- Run `./update.sh` to renew certificates
- Check nginx logs: `docker logs storage-nginx`

**Container won't start**
- Check logs: `docker logs storage-app`
- Verify `.env` file exists and is valid

**Database connection fails**
- Verify `DATABASE_URL` in `.env`
- Check Neon dashboard for connection limits

---

**See Also:**
- [Getting Started](getting-started.md) — Installation guide
- [Deployment](deployment.md) — Production deployment

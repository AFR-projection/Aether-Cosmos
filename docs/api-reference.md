# 📡 API Reference

REST API documentation for Storage ByAFR.

---

## Authentication

All API requests require session authentication via cookies.

**Admin API Keys:**
- Create via Admin Panel → API Keys
- Include in header: `Authorization: Bearer <key>`

---

## Endpoints

### Files
- `GET /api/files` — List files
- `POST /api/uploads/init` — Initialize upload
- `POST /api/uploads/[id]/complete` — Complete upload
- `DELETE /api/files/[id]` — Delete file

### Second Brain
- `GET /api/brain/[id]` — Get brain info
- `GET /api/brain/[id]/graph` — Knowledge graph snapshot
- `POST /api/brain/[id]/memories` — Create memory
- `POST /api/brain/mcp` — MCP endpoint for AI agents

---

**See Also:**
- [Second Brain MCP](second-brain-mcp.md) — MCP tools documentation
- [Development](development.md) — API design guidelines

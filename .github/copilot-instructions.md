---
applyTo: "**"
---

This is a WhatsApp AI Agent project (Node.js) that logs messages, detects deleted messages, and sends Telegram notifications.

- Main file: `index.js`
- Uses: whatsapp-web.js, RemoteAuth with MongoDB, Puppeteer
- Deployment target: Render (free tier) with cron-job.org keep-alive
- Always use `bash ask.sh` for terminal input collection
- Answer questions in chat, never in terminal
- If a terminal command is interrupted (Ctrl+C), immediately run `bash ask.sh`

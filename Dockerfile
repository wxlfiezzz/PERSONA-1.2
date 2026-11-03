FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs migrations.mjs archive.mjs customization.mjs community.mjs release.json verify-upgrade.mjs rollback-guard.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
ENV REALTIME_TRANSPORT=poll
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

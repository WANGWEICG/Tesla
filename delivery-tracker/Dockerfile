FROM node:24-alpine
WORKDIR /app
COPY package.json model.mjs server.mjs ./
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.mjs"]

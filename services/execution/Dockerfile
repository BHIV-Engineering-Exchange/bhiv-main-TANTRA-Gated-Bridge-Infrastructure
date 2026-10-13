FROM node:18-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY execution/package*.json ./
RUN npm install --production
COPY sdk/ ./sdk/
COPY execution/ ./execution/
COPY observability/ ./observability/
COPY replay_persistence/ ./replay_persistence/
COPY insightflow/ ./insightflow/
EXPOSE 3003
CMD ["node", "execution/app.js"]

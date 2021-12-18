FROM node:14.15.3-buster-slim
ENV DOCKER=true
WORKDIR /var/www/app
COPY package.json .
COPY yarn.lock .
RUN yarn install --ignore-scripts
COPY . .
CMD [ "node", "index.js" ]

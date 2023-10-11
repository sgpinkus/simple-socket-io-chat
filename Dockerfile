FROM node:16.18-buster-slim
ENV DOCKER=true
WORKDIR /var/www/app
COPY package.json .
COPY package-lock.json .
COPY .npmrc .
RUN npm i
COPY . .
ENTRYPOINT ["npm", "run"]

FROM nginx:stable-alpine

COPY . /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint-prod.sh /docker-entrypoint.d/99-fleet-runtime-config.sh

RUN chmod +x /docker-entrypoint.d/99-fleet-runtime-config.sh \
    && rm -f /usr/share/nginx/html/nginx.conf /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/docker-entrypoint-prod.sh

EXPOSE 8080

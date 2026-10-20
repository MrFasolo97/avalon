FROM node:24-alpine
COPY test/force-finalize.js /test/
CMD ["node", "/test/force-finalize.js"]
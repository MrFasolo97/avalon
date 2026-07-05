FROM node:18-alpine
COPY test/force-finalize.js /test/
CMD ["node", "/test/force-finalize.js"]
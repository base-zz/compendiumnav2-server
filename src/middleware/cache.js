import redis from 'redis';
const client = redis.createClient(process.env.REDIS_URL);

export const navCache = (duration) => {
  return (req, res, next) => {
    const key = `nav:${req.originalUrl}`;
    
    client.get(key, (err, data) => {
      if (data) {
        res.send(JSON.parse(data));
      } else {
        const oldSend = res.send;
        res.send = (body) => {
          client.setex(key, duration, body);
          oldSend.call(res, body);
        };
        next();
      }
    });
  };
};
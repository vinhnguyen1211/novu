import { IoAdapter } from '@nestjs/platform-socket.io';
import Redis from 'ioredis';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import * as redisIoAdapter from 'socket.io-redis';
import { getRedisPrefix } from '@novu/shared';

export class RedisIoAdapter extends IoAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createIOServer(port: number, options?: any): any {
    const server = super.createIOServer(port, options);
    // const keyPrefix = 'socket.io#' + `${getRedisPrefix() ?? ''}`;
    const keyPrefix = `${getRedisPrefix() ?? ''}`;

    const pubClient = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD,
      keyPrefix,
    });
    const subClient = pubClient.duplicate();

    /*
     * const client = createClient({
     *   socket: {
     *     host: process.env.REDIS_HOST,
     *     port: Number(process.env.REDIS_PORT),
     *   },
     *   password: process.env.REDIS_PASSWORD,
     *   prefix: () => {
     *     // if custom prefix is empty ensure that the default prefix is set
     *     let prefix = 'socket.io';
     *     if (getRedisPrefix()) {
     *       prefix += '#' + getRedisPrefix();
     *     }
     */

    /*
     *     return prefix;
     *   },
     * });
     */
    /*
     *  const redisAdapter = redisIoAdapter({
     *  });
     */

    server.adapter(createAdapter(pubClient, subClient));

    return server;
  }
}

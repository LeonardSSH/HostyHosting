import 'reflect-metadata';
import Koa from 'koa';
import Router from '@koa/router';
import cors from '@koa/cors';
import bodyParser from 'koa-bodyparser';
import session from 'koa-session';
import redisStore from 'koa-redis';
import { ApolloServer } from 'apollo-server-koa';
import { createConnection, getCustomRepository } from 'typeorm';
import redis from './redis';
import ormconfig from '../ormconfig';
import { buildSchema, AuthChecker } from 'type-graphql';
import { SESSION_NAME } from './constants';
import path from 'path';
import { Context } from './types';
import { removeUserCookie } from './utils/cookies';
import { UserRepository } from './repositories/UserRepository';
import { run } from './utils/currentRequest';

const app = new Koa();
const router = new Router();

app.keys = ['Some key here ignore'];

const SESSION_CONFIG = {
    key: SESSION_NAME,
    maxAge: 86400000 * 14,
    autoCommit: true,
    overwrite: true,
    httpOnly: true,
    signed: true,
    rolling: true,
    renew: false,
    store: redisStore({
        client: redis,
    }),
};

// Put the current request in our thread local storage:
app.use(async (ctx, next) => {
    await run(ctx, next);
});

app.use(
    cors({
        credentials: true,
    }),
);

app.use(session(SESSION_CONFIG, app));
app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

async function main() {
    const customAuthChecker: AuthChecker<Context> = ({ context }, roles) => {
        if (!context.user) {
            return false;
        }

        if (!roles || roles.length === 0) {
            return true;
        }

        // TODO: Expand this into other roles eventually:
        if (!roles.includes(context.user.grantType)) {
            return false;
        }

        return true;
    };

    const schema = await buildSchema({
        resolvers: [__dirname + '/resolvers/**/*.{ts,js}'],
        emitSchemaFile: path.resolve(__dirname, 'schema.gql'),
        authChecker: customAuthChecker,
    });

    const server = new ApolloServer({
        debug: true,
        schema,
        context: ({ ctx, connection }) => {
            if (connection?.context) {
                return connection.context;
            }

            return {
                user: ctx.user,
                destroySession() {
                    ctx.session = null;
                },
            };
        },
    });

    const connection = await createConnection(ormconfig);
    const userRepo = getCustomRepository(UserRepository);

    app.use((ctx, next) => {
        ctx.connection = connection;
        return next();
    });

    app.use(async (ctx, next) => {
        if (ctx.get('Authentication')) {
            ctx.user = await userRepo.fromAPIKey(ctx.get('Authentication').slice('Bearer '.length));
        } else {
            ctx.user = await userRepo.fromSession();
        }

        if (!ctx.user) {
            removeUserCookie();
        }

        return next();
    });

    server.applyMiddleware({ app, path: '/api/graphql' });

    console.log('Connected to the database.');

    const httpServer = app.listen(1337, () => {
        console.log('Koa server listening on port 1337');
    });

    server.installSubscriptionHandlers(httpServer);
}

main().catch(err => console.error(err));

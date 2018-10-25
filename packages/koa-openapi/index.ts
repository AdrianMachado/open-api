import OpenAPIFramework, {
  OpenAPIFrameworkArgs,
  OpenAPIFrameworkConstructorArgs,
  OpenAPIFrameworkPathContext,
  OpenAPIFrameworkOperationContext,
  OpenAPIFrameworkAPIContext
} from 'openapi-framework';
import { Context, Middleware } from 'koa';

const loggingPrefix = 'koa-openapi';

export interface KoaRouter {
  delete: (...any) => any;
  get: (...any) => any;
  post: (...any) => any;
  put: (...any) => any;
  use: (...any) => any;
}

export interface KoaOpenAPIInitializeArgs extends OpenAPIFrameworkArgs {
  consumesMiddleware?: {[mimeType: string]: Middleware},
  docsPath: string,
  errorMiddleware: Middleware,
  exposeApiDocs: boolean,
  router: KoaRouter,
  securityFilter: Middleware,
}

export function initialize(args: KoaOpenAPIInitializeArgs): OpenAPIFramework {
  if (!args) {
    throw new Error(`${loggingPrefix}: args must be an object`);
  }

  if (!args.router) {
    throw new Error(`${loggingPrefix}: args.router must be a koa router`);
  }

 const exposeApiDocs = 'exposeApiDocs' in args ?
      !!args.exposeApiDocs :
      true;

  if (args.docsPath && typeof args.docsPath !== 'string') {
    throw new Error(`${loggingPrefix}: args.docsPath must be a string when given`);
  }

  if ('securityFilter' in args && typeof args.securityFilter !== 'function') {
    throw new Error(`${loggingPrefix}: args.securityFilter must be a function when given`);
  }

  const router = args.router;
  // Do not make modifications to this.
  const docsPath = args.docsPath || '/api-docs';
  const consumesMiddleware = args.consumesMiddleware;
  const errorMiddleware = typeof args.errorMiddleware === 'function' &&
      args.errorMiddleware.length === 4 ? args.errorMiddleware : null;
  const securityFilter = args.securityFilter
    || function defaultSecurityFilter(ctx, next) {
      ctx.status = 200;
      ctx.body = ctx.state.apiDoc;
    };

  const frameworkArgs: OpenAPIFrameworkConstructorArgs = {
    apiDoc: args.apiDoc,
    featureType: 'middleware',
    name: loggingPrefix,
    paths: args.paths,
    ...(args as OpenAPIFrameworkArgs)
  };

  const framework = new OpenAPIFramework(frameworkArgs);

  framework.initialize({
    visitApi: function(apiCtx: OpenAPIFrameworkAPIContext) {
      if (exposeApiDocs) {
        // Swagger UI support
        router.get(apiCtx.basePath + docsPath, function(ctx: Context, next) {
          ctx.state.apiDoc = apiCtx.getApiDoc();
          if (ctx.state.apiDoc.swagger) {
            ctx.state.apiDoc.host = ctx.headers.host;
            ctx.state.apiDoc.basePath = apiCtx.basePath;
          }
          securityFilter(ctx, next);
        });
      }

      if (errorMiddleware) {
        router.use(apiCtx.basePath, errorMiddleware);
      }
    },

    visitOperation: function(operationCtx: OpenAPIFrameworkOperationContext) {
      const apiDoc = operationCtx.apiDoc;
      const methodName = operationCtx.methodName;
      const operationDoc = operationCtx.operationDoc;
      const operationHandler = operationCtx.operationHandler;
      let middleware = [].concat(operationCtx.additionalFeatures);

      if (operationDoc && operationCtx.allowsFeatures) {
        middleware.unshift(createAssignApiDocMiddleware(apiDoc, operationDoc));

        if (operationCtx.features.responseValidator) {
          // add response validation middleware
          // it's invalid for a method doc to not have responses, but the post
          // validation will pick it up, so this is almost always going to be added.
          middleware.unshift(function responseValidatorMiddleware(ctx: Context) {
            ctx.state.validateResponse = function(statusCode, response) {
              return operationCtx.features.responseValidator.validateResponse(statusCode, response);
            };
          });
        }

        if (operationCtx.features.requestValidator) {
          middleware.unshift(function requestValidatorMiddleware(ctx: Context) {
            const errors = operationCtx.features.requestValidator.validate(toOpenAPIRequest(ctx));
            if (errors) {
              ctx.throw(errors.status, errors);
            }
          });
        }

        if (operationCtx.features.coercer) {
          middleware.unshift(function coercerMiddleware(ctx: Context) {
            operationCtx.features.coercer.coerce(toOpenAPIRequest(ctx));
          });
        }

        if (operationCtx.features.defaultSetter) {
          middleware.unshift(function defaultMiddleware(ctx: Context) {
            operationCtx.features.defaultSetter.handle(toOpenAPIRequest(ctx));
          });
        }

        if (operationCtx.features.securityHandler) {
          middleware.push(createSecurityMiddleware(operationCtx.features.securityHandler));
        }

        if (consumesMiddleware && operationCtx.consumes) {
          addConsumesMiddleware(middleware, consumesMiddleware, operationCtx.consumes);
        }
      }

      middleware = middleware.concat(operationHandler);

      const koaPath = operationCtx.basePath + '/' +
          operationCtx.path.substring(1).split('/').map(toPathParams).join('/');
      router[methodName](koaPath, async (ctx, next) => {
        for(let fn of middleware) {
          await fn(ctx, next);
        }
      });
    }
  });

  return framework;
}


function addConsumesMiddleware(middleware, consumesMiddleware, consumes) {
  for (var i = consumes.length - 1; i >= 0; --i) {
    var mimeType = consumes[i];
    if (mimeType in consumesMiddleware) {
      var middlewareToAdd = consumesMiddleware[mimeType];
      middleware.unshift(middlewareToAdd);
    }
  }
}

function createAssignApiDocMiddleware(apiDoc, operationDoc) {
  return function assignApiDocMiddleware(ctx: Context) {
    ctx.state.apiDoc = apiDoc;
    ctx.state.operationDoc = operationDoc;
  };
}

function createSecurityMiddleware(handler) {
  return function securityMiddleware(ctx: Context) {
    handler.handle(ctx, function(err, result) {
      if (err) {
        if (err.challenge) {
          ctx.set('www-authenticate', err.challenge);
        }
        ctx.status = err.status;

        if (typeof err.message === 'string') {
          ctx.body = err.message;
        } else {
          ctx.body = err.message;
        }
      }
    });
  };
}

function toOpenAPIRequest(ctx) {
  return {
    body: ctx.request.body,
    headers: ctx.request.headers,
    params: ctx.params,
    query: ctx.request.query,
  };
}

function toPathParams(part) {
  return part.replace(/\{([^}]+)}/g, ':$1');
}

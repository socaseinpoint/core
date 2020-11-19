import { resolve } from 'path'
import * as Bluebird from 'bluebird'
import { Microfleet, ServiceAction, ServiceRequest } from '@microfleet/core'
import _debug = require('debug')
import { Tags } from 'opentracing'
import { v4 as uuidv4 } from 'uuid'
import { isFunction } from 'lodash'

import Lifecycle from './lifecycle'
import RequestCountTracker from './tracker'
import Routes from './routes/collection'
import { RouterPluginConfig } from './types/plugin'
import {
  wrapPromiseWithSpan,
  readRoutes,
  createServiceAction,
  requireServiceActionHandler,
} from './utils'

const { COMPONENT } = Tags
const debug = _debug('@microfleet/router - dispatch')

export type RequestCallback = (err: any, result?: any) => void

export default class Router {
  static readonly ROUTES_WITH_EMPTY_TRANSPORT = Symbol('empty_transport')

  public readonly config: RouterPluginConfig

  public readonly requestCountTracker: RequestCountTracker

  protected readonly service: Microfleet

  protected readonly lifecycle: Lifecycle

  protected readonly routes: Routes

  // extensions: Extensions

  // routes: RouteMap

  constructor(config: RouterPluginConfig, service: Microfleet) {
    this.config = config
    this.service = service
    this.lifecycle = new Lifecycle(config, service)
    this.requestCountTracker = new RequestCountTracker(service)
    this.routes = new Routes()

    const { routes: { directory, enabledGenericActions } } = config

    if (directory !== undefined) {
      this.loadActionsFromDirectory(directory)
    }

    if (enabledGenericActions !== undefined) {
      this.loadGenericActions(enabledGenericActions)
    }
  }

  public prefix(route: string): string {
    const { prefix } = this.config.routes

    // @todo fix config with empty string
    if (prefix !== undefined && prefix !== '') {
      return `${prefix}.${route}`
    }

    return route
  }

  public addRoute(route: string, handler: ServiceAction): void {
    const { routes } = this

    const action = createServiceAction(route, handler)

    for (const transport of (handler.transports || [Router.ROUTES_WITH_EMPTY_TRANSPORT])) {
      // @todo enabled[route] can be used for rename route
      routes.add(this.prefix(route), transport, action)
    }
  }

  public getAction(route: string, transport: string): ServiceAction | undefined {
    return this.routes.get(route, transport) as ServiceAction
       || this.routes.get(route, Router.ROUTES_WITH_EMPTY_TRANSPORT) as ServiceAction
  }

  public getRoutes(transport: string): Map<string, ServiceAction> {
    return new Map([
      ...this.routes.getForTransport(transport) as Map<string, ServiceAction>,
      ...this.routes.getForTransport(Router.ROUTES_WITH_EMPTY_TRANSPORT) as Map<string, ServiceAction>,
    ])
  }

  public loadGenericActions(enabled: string[]): void {
    for (const route of enabled) {
      const handler = requireServiceActionHandler(resolve(__dirname, `./routes/generic/${route}`))

      this.addRoute(`generic.${route}`, handler)
    }
  }

  public loadActionsFromDirectory(directory: string): void {
    const { config: { routes: { enabled } } } = this

    for (const [route, handler] of readRoutes(directory)) {
      if (enabled !== undefined && enabled[route] === undefined) {
        continue
      }

      this.addRoute(route, handler)
    }
  }

  // @todo async?
  // @todo (BC) get route from request
  public dispatch(route: string, request: ServiceRequest): Bluebird<any>
  public dispatch(route: string, request: ServiceRequest, callback: RequestCallback): void
  public dispatch(route: string, request: ServiceRequest, callback?: RequestCallback): Bluebird<any> | void {
    debug('initiating request on route %s', route)

    const { service } = this
    const { tracer, log } = service

    // @todo extension?
    // if we have installed tracer - init span
    if (tracer !== undefined) {
      request.span = tracer.startSpan(`dispatch:${route}`, {
        childOf: request.parentSpan,
        tags: {
          [COMPONENT]: request.transport,
        },
      })
    }

    request.log = log.child({
      reqId: uuidv4(),
    })

    let result: Bluebird<unknown>

    // @todo
    if (isFunction(callback)) {
      result = Bluebird.resolve(this.lifecycle.runWithResponse(request))
    } else {
      result = Bluebird.resolve(this.lifecycle.run(request))
    }

    return request.span !== undefined
      ? wrapPromiseWithSpan(request.span, result, callback)
      : result.asCallback(callback)
  }
}
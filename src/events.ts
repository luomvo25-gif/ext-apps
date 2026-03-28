import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  Request,
  Notification,
  Result,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodLiteral, ZodObject } from "zod/v4";

type MethodSchema = ZodObject<{ method: ZodLiteral<string> }>;

/**
 * Intermediate base class that adds multi-listener event support on top of the
 * MCP SDK's `Protocol`.
 *
 * The base `Protocol` class stores one handler per method:
 * `setRequestHandler()` and `setNotificationHandler()` replace any existing
 * handler for the same method. When two pieces of code set the same handler
 * (for example, two React hooks both listening to `hostcontextchanged`), the
 * second silently overwrites the first.
 *
 * This class introduces:
 *
 * - {@link addEventListener `addEventListener`} /
 *   {@link removeEventListener `removeEventListener`} — append to a
 *   per-event listener array. The first listener for an event lazily
 *   registers a dispatcher with the base class that fans out to all
 *   listeners.
 * - Overridden {@link setRequestHandler `setRequestHandler`} /
 *   {@link setNotificationHandler `setNotificationHandler`} — throw if a
 *   handler for the same method has already been registered (through either
 *   path), so accidental overwrites surface as errors instead of silent bugs.
 *
 * Subclasses provide the event-name → schema map via `eventSchemas` and may
 * override {@link onEventDispatch `onEventDispatch`} to run per-notification
 * side effects (for example, {@link App `App`} merges `hostcontextchanged`
 * params into its cached host context before listeners fire).
 *
 * @typeParam EventMap - Maps event names to the listener's `params` type.
 */
export abstract class ProtocolWithEvents<
  SendRequestT extends Request,
  SendNotificationT extends Notification,
  SendResultT extends Result,
  EventMap extends Record<string, unknown>,
> extends Protocol<SendRequestT, SendNotificationT, SendResultT> {
  private _registeredMethods = new Set<string>();
  private _eventListeners = new Map<
    keyof EventMap,
    ((params: unknown) => void)[]
  >();

  /**
   * Event name → notification schema. Subclasses populate this so that
   * {@link addEventListener `addEventListener`} can lazily register a
   * dispatcher with the correct schema.
   */
  protected abstract readonly eventSchemas: {
    [K in keyof EventMap]: MethodSchema;
  };

  /**
   * Called once per incoming notification, before any listeners fire.
   * Subclasses may override to perform side effects such as merging
   * notification params into cached state.
   */
  protected onEventDispatch<K extends keyof EventMap>(
    _event: K,
    _params: EventMap[K],
  ): void {}

  /**
   * Register a request handler without tracking it. Subclass constructors use
   * this for overridable defaults — a later `setRequestHandler` or `on*`
   * setter call for the same method will succeed once (replacing the default)
   * before throw-on-double kicks in.
   */
  protected setDefaultRequestHandler: Protocol<
    SendRequestT,
    SendNotificationT,
    SendResultT
  >["setRequestHandler"] = (schema, handler) =>
    super.setRequestHandler(schema, handler);

  // The two overrides below are arrow-function class fields rather than
  // prototype methods so that Protocol's constructor — which registers its
  // own ping/cancelled/progress handlers via `this.setRequestHandler` before
  // our fields initialize — hits the base implementation and skips tracking.
  // Converting these to proper methods would crash with `_registeredMethods`
  // undefined during super().

  /**
   * Registers a request handler. Throws if a handler for the same method has
   * already been registered — use {@link addEventListener `addEventListener`}
   * if you need multiple listeners for a notification.
   *
   * @throws {Error} if a handler for this method is already registered.
   */
  override setRequestHandler: Protocol<
    SendRequestT,
    SendNotificationT,
    SendResultT
  >["setRequestHandler"] = (schema, handler) => {
    this._assertMethodNotRegistered(schema, "setRequestHandler");
    super.setRequestHandler(schema, handler);
  };

  /**
   * Registers a notification handler. Throws if a handler for the same method
   * has already been registered — use
   * {@link addEventListener `addEventListener`} if you need multiple
   * listeners.
   *
   * @throws {Error} if a handler for this method is already registered.
   */
  override setNotificationHandler: Protocol<
    SendRequestT,
    SendNotificationT,
    SendResultT
  >["setNotificationHandler"] = (schema, handler) => {
    this._assertMethodNotRegistered(schema, "setNotificationHandler");
    super.setNotificationHandler(schema, handler);
  };

  /**
   * Add a listener for a notification event.
   *
   * Unlike {@link setNotificationHandler `setNotificationHandler`}, calling
   * this multiple times appends listeners rather than replacing them. All
   * registered listeners fire in insertion order when the notification
   * arrives.
   *
   * Registration is lazy: the first listener for a given event causes a
   * dispatcher to be registered with the base `Protocol` via
   * `setNotificationHandler`. Subsequent listeners are pushed onto the same
   * array.
   *
   * @param event - Event name (a key of the `EventMap` type parameter).
   * @param handler - Listener invoked with the notification `params`.
   *
   * @throws {Error} if the event name is unknown, or if a handler for the
   *   underlying method was already registered via
   *   {@link setNotificationHandler `setNotificationHandler`}.
   */
  addEventListener<K extends keyof EventMap>(
    event: K,
    handler: (params: EventMap[K]) => void,
  ): void {
    let listeners = this._eventListeners.get(event);
    if (!listeners) {
      const schema = this.eventSchemas[event];
      if (!schema) {
        throw new Error(`Unknown event: ${String(event)}`);
      }
      listeners = [];
      this._eventListeners.set(event, listeners);
      this._assertMethodNotRegistered(schema, "addEventListener");
      super.setNotificationHandler(schema, (n) => {
        const params = (n as { params: EventMap[K] }).params;
        this.onEventDispatch(event, params);
        for (const l of listeners!) l(params);
      });
    }
    listeners.push(handler as (params: unknown) => void);
  }

  /**
   * Remove a previously registered event listener. The dispatcher stays
   * registered even if the listener array becomes empty; future notifications
   * simply have no listeners to call.
   */
  removeEventListener<K extends keyof EventMap>(
    event: K,
    handler: (params: EventMap[K]) => void,
  ): void {
    const listeners = this._eventListeners.get(event);
    if (!listeners) return;
    const idx = listeners.indexOf(handler as (params: unknown) => void);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  private _assertMethodNotRegistered(schema: unknown, via: string): void {
    const method = (schema as MethodSchema).shape.method.value;
    if (this._registeredMethods.has(method)) {
      throw new Error(
        `Handler for "${method}" already registered (via ${via}). ` +
          `Use addEventListener() to attach multiple listeners.`,
      );
    }
    this._registeredMethods.add(method);
  }
}

/* Copyright 2026 Marimo. All rights reserved. */

import { Effect, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  type HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";
import { CreateNotebookRequest } from "./Requests.ts";
import { Notebook as NotebookRecord } from "../model/Catalog.ts";
import { HostRecord } from "../model/Discovery.ts";
import * as Problems from "../Problems.ts";
import * as P from "./Parameters.ts";
import { makeGroup, sseEvents } from "../internal/http.ts";
import { forGenerators } from "../internal/openapi.ts";

/** Maps request decoding failures to the host protocol's invalid-request problem. */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "@marimo-team/host-protocol/Host/RequestValidation",
  { error: Problems.InvalidRequestProblem },
) {
  static readonly layer = HttpApiMiddleware.layerSchemaErrorTransform(
    RequestValidation,
    (error) =>
      error.kind === "Body" || error.kind === "ResponseHeaders"
        ? Effect.fail(error)
        : Effect.fail(new Problems.InvalidRequestProblem()),
  );
}

/** Admits requests that carry the host record's token from this machine. */
export class HostToken extends HttpApiMiddleware.Service<HostToken>()(
  "@marimo-team/host-protocol/Host/HostToken",
  {
    security: {
      hostToken: HttpApiSecurity.bearer.pipe(
        HttpApiSecurity.annotate(
          OpenApi.Description,
          "The `token` from a host record, sent as `Authorization: Bearer\n<token>` on every request. Hosts accept the token only in that\nheader and omit CORS headers. Hosts answer only requests that arrive\nover the machine's own loopback interface. Clients disable redirects\nto keep authenticated requests on that interface.\n",
        ),
      ),
    },
    error: [Problems.UnauthorizedProblem, Problems.ForbiddenProblem],
  },
) {}

export const Create = HttpApiEndpoint.post("create", "/notebooks", {
  headers: P.idempotent,
  payload: CreateNotebookRequest,
  success: [
    NotebookRecord.pipe(HttpApiSchema.status(201)).annotateKey({
      description: "The notebook was created.",
    }),
  ],
  error: [...Problems.Mutation.members],
})
  .annotate(OpenApi.Identifier, "notebook.create")
  .annotate(OpenApi.Summary, "Create a notebook")
  .annotate(
    OpenApi.Description,
    "Adds an empty notebook to the project. The request carries the\nnotebook's own fields, and the host fills in what it owns. In a\nproject with a `root`, `path` is required and `name` defaults to\nthe filename; if a file already exists at `path`, the host\nanswers `conflict` and leaves it alone. In a project without a\nroot, `name` is required, the host chooses storage, and `path` is\nnull. A request missing the required field is `invalid-request`.\nThe new notebook appears on the catalog stream with this\nrequest's key.\n",
  );

const makeEvents = <E extends Schema.Constraint>(events: E) =>
  HttpApiEndpoint.get("events", "/events", {
    query: Schema.Struct({ kinds: Schema.optionalKey(P.Kinds) }).pipe(
      Schema.encodeKeys({ kinds: "kinds" }),
    ),
    headers: Schema.Struct({
      cursor: Schema.optionalKey(P.LastEventId),
    }).pipe(Schema.encodeKeys({ cursor: "last-event-id" })),
    success: [
      HttpApiSchema.StreamSse({ events: sseEvents(events) })
        .pipe(HttpApiSchema.status(200))
        .annotateKey({
          description: "The catalog, then changes, as server-sent events.",
        }),
    ],
    error: [...Problems.Common.members],
  })
    .annotate(OpenApi.Identifier, "events")
    .annotate(OpenApi.Summary, "Read the host's catalog as a stream")
    .annotate(
      OpenApi.Description,
      "Streams the host, its projects, notebooks, runtimes, and\nattachments. A snapshot sends one record per selected object,\nparents before children. Snapshot records omit `id`. Live records\nand removals carry an `id` and timestamp. Every snapshot and resume\nends with `ready` carrying the current cursor, followed by live\nchanges.\n\nReconnect with the last `id` in `Last-Event-ID` and the same `kinds`\nfilter. At `ready`, the client's records must match a fresh snapshot\nat that cursor. The host may skip superseded records and removals.\nEvents it sends keep their original order, ids, and timestamps.\n\nThe host may send `reset` and a fresh snapshot, and must do so if it\ncannot resume or the cursor predates a loss of host state. On\n`reset`, clear the records and cursor. Discard an incomplete\nsnapshot before reconnecting without a cursor.\n\n`kinds` filters objects, including the host, and their removals. It\npreserves stream positions and always includes `ready` and `reset`.\nThe host sends a `: ping` comment every fifteen seconds when idle.\nReconnect after 45 seconds of silence.\n",
    );

export const group = <
  E extends Schema.Constraint,
  const Endpoints extends readonly HttpApiEndpoint.Constraint[] = readonly [],
>(
  events: E,
  ...endpoints: Endpoints
) => makeGroup("Host", Create, makeEvents(events), ...endpoints);

export const makeApi = <
  CatalogEvent extends Schema.Constraint,
  NotebookEvent extends Schema.Constraint,
  const CatalogEndpoints extends readonly HttpApiEndpoint.Constraint[],
  NotebookEndpoint extends HttpApiEndpoint.Constraint,
>(
  events: {
    CatalogStreamEvent: CatalogEvent;
    NotebookStreamEvent: NotebookEvent;
    Event: Schema.Constraint;
    ObjectKind: Schema.Constraint;
  },
  catalogEndpoints: CatalogEndpoints,
  notebook: HttpApiGroup.HttpApiGroup<"Notebook", NotebookEndpoint>,
) =>
  HttpApi.make("Host")
    .add(group(events.CatalogStreamEvent, ...catalogEndpoints), notebook)
    .middleware(RequestValidation)
    .middleware(HostToken)
    .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
    .annotate(HttpApi.AdditionalSchemas, [
      events.Event,
      events.CatalogStreamEvent,
      events.NotebookStreamEvent,
      events.ObjectKind,
      HostRecord,
      Problems.Problem,
      Problems.UnknownProblem,
    ])
    .annotate(OpenApi.Title, "marimo host protocol")
    .annotate(OpenApi.Version, "1.0.0")
    .annotate(
      OpenApi.Description,
      "The contract a marimo host serves so that other programs on the same\nmachine can find it, see what it has, and work with its notebooks. A\nhost is a program that runs marimo notebooks, such as the marimo CLI\nor the VS Code extension. A client is a program that talks to a host\nfrom the outside, such as Pair.\n\nA host writes a small file, the host record, that says where its API\nis and how to authenticate. A client reads that file, opens the host's\nevent stream to learn what it has, and calls the operations the host\nlists. There are two streams: `/events` carries the catalog, and\n`/notebooks/{notebook_id}/events` carries one notebook: its cells and\ndocument, its runtime, and the runs of code against it. Clients ignore\nfields, operation names, event\nnames, and problem types they do not recognize. A host rejects a request\nbody that has a member it does not recognize. A change that would\nbreak an existing client requires a new record version and a new base\npath.\n",
    )
    .annotate(OpenApi.Transform, forGenerators);

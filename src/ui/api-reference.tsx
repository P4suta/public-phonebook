import { type FormEvent, type ReactElement, useRef, useState } from "react";
import {
  codeExamples,
  exampleValues,
  operationSearchKey,
  planReferenceRequest,
  type ReferenceModel,
  type ReferenceOperation,
  type ReferenceParameter,
  type ReferenceSearch,
  type ReferenceValues,
  requestValues,
} from "../core/api-reference.ts";
import * as css from "./api-reference.css.ts";
import {
  referenceCopy,
  showsContractText,
  statusMeaning,
} from "./api-reference-copy.ts";
import { CopyButton } from "./components.tsx";
import { Icon } from "./icons.tsx";
import {
  attemptPlan,
  browserSender,
  displayLimitKibibytes,
  type ReferenceAttempt,
} from "./reference-request.ts";
import * as styles from "./styles.css.ts";

function japaneseSummary(operation: ReferenceOperation): string {
  return referenceCopy.summaries[operation.id] ?? operation.summary;
}

function operationName(operation: ReferenceOperation): string {
  return `${operation.method} ${operation.path}`;
}

function Navigation({
  model,
}: {
  readonly model: ReferenceModel;
}): ReactElement {
  return (
    <nav aria-label={referenceCopy.navigation} className={css.navigation}>
      {model.groups.map((group, index) => (
        <div key={group.tag} className={css.navigationGroup}>
          <p id={`navigation-${index}`} className={css.navigationLabel}>
            {referenceCopy.tags[group.tag] ?? group.tag}
          </p>
          <ul className={css.list} aria-labelledby={`navigation-${index}`}>
            {group.operations.map((operation) => (
              <li key={operation.id}>
                <a href={`#${operation.id}`} className={css.navigationLink}>
                  <span>{japaneseSummary(operation)}</span>
                  <code>{operationName(operation)}</code>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function parameterNote(parameter: ReferenceParameter): string {
  return `${referenceCopy.location[parameter.location]}、${parameter.required ? referenceCopy.required : referenceCopy.optional}`;
}

function Parameters({
  operation,
}: {
  readonly operation: ReferenceOperation;
}): ReactElement {
  const heading = `${operation.id}-parameters`;
  const columns = referenceCopy.parameterColumns;
  return (
    <>
      <h4 id={heading} className={css.subheading}>
        {referenceCopy.parameters}
      </h4>
      {operation.parameters.length === 0 ? (
        <p className={css.body}>{referenceCopy.noParameters}</p>
      ) : (
        <table className={css.table} aria-labelledby={heading}>
          <thead>
            <tr>
              <th scope="col">{columns.name}</th>
              <th scope="col">{columns.value}</th>
              <th scope="col">{columns.description}</th>
            </tr>
          </thead>
          <tbody>
            {operation.parameters.map((parameter) => (
              <tr key={parameter.name}>
                <th scope="row">
                  <code>{parameter.name}</code>
                  <span className={css.cellNote}>
                    {parameterNote(parameter)}
                  </span>
                </th>
                <td>
                  <code>{parameter.type}</code>
                  {parameter.choices.length > 0 && (
                    <span className={css.cellNote}>
                      {referenceCopy.choices(parameter.choices.length)}
                    </span>
                  )}
                  {parameter.constraints.map((constraint) => (
                    <span key={constraint.kind} className={css.cellNote}>
                      {referenceCopy.constraints[constraint.kind]}：
                      <code>{constraint.value}</code>
                    </span>
                  ))}
                </td>
                <td lang="en">{parameter.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Responses({
  operation,
}: {
  readonly operation: ReferenceOperation;
}): ReactElement {
  const heading = `${operation.id}-responses`;
  const columns = referenceCopy.responseColumns;
  return (
    <>
      <h4 id={heading} className={css.subheading}>
        {referenceCopy.responses}
      </h4>
      <table className={css.table} aria-labelledby={heading}>
        <thead>
          <tr>
            <th scope="col">{columns.status}</th>
            <th scope="col">{columns.description}</th>
            <th scope="col">{columns.media}</th>
          </tr>
        </thead>
        <tbody>
          {operation.responses.map((response) => (
            <tr key={response.status}>
              <th scope="row">
                <code>{response.status}</code>
                <span className={css.cellNote}>
                  {statusMeaning(Number(response.status))}
                </span>
              </th>
              <td lang="en">{response.description}</td>
              <td>
                {response.mediaTypes.length === 0
                  ? referenceCopy.noBody
                  : response.mediaTypes.map((mediaType) => (
                      <code key={mediaType} className={css.cellNote}>
                        {mediaType}
                      </code>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Examples({
  operation,
  origin,
}: {
  readonly operation: ReferenceOperation;
  readonly origin: string;
}): ReactElement {
  const examples = codeExamples(origin, operation);
  return (
    <>
      <h4 className={css.subheading}>{referenceCopy.examples}</h4>
      {examples.placeholders && (
        <p className={css.body}>{referenceCopy.placeholders}</p>
      )}
      {(
        [
          ["curl", examples.curl],
          ["JavaScript", examples.javascript],
        ] as const
      ).map(([language, code]) => (
        <figure key={language} className={css.example}>
          <figcaption className={css.exampleLabel}>{language}</figcaption>
          <pre className={styles.code}>
            <code>{code}</code>
          </pre>
          <CopyButton
            value={code}
            label={referenceCopy.copyExample(language)}
            subject={`${language}のコード例`}
            accessibleLabel={`${referenceCopy.copyExample(language)}（${operationName(operation)}）`}
          />
        </figure>
      ))}
    </>
  );
}

function Field({
  operation,
  parameter,
  value,
}: {
  readonly operation: ReferenceOperation;
  readonly parameter: ReferenceParameter;
  readonly value: string;
}): ReactElement {
  const id = `${operation.id}-field-${parameter.name}`;
  return (
    <div className={css.field}>
      <label htmlFor={id} className={css.label}>
        <code>{parameter.name}</code>
        <span>（{parameterNote(parameter)}）</span>
      </label>
      {parameter.choices.length > 0 ? (
        <span className={css.selection}>
          <select
            id={id}
            name={parameter.name}
            defaultValue={value}
            required={parameter.required}
            className={css.select}
          >
            <option value="">{referenceCopy.attempt.unspecified}</option>
            {parameter.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" className={css.chevron} />
        </span>
      ) : (
        <input
          id={id}
          name={parameter.name}
          type="text"
          defaultValue={value}
          required={parameter.required}
          inputMode={parameter.type === "integer" ? "numeric" : undefined}
          autoComplete="off"
          spellCheck={false}
          className={css.control}
        />
      )}
    </div>
  );
}

function statusLine(
  attempt: ReferenceAttempt | null,
  sending: boolean,
): string {
  if (sending) return referenceCopy.attempt.sending;
  switch (attempt?.outcome) {
    case undefined:
      return "";
    case "response":
      return referenceCopy.attempt.status(attempt.status);
    case "failed":
      return referenceCopy.attempt.failed;
    case "unknown_operation":
      return referenceCopy.attempt.unknownOperation;
    case "incomplete_path":
      return referenceCopy.attempt.incompletePath;
  }
}

function AttemptBody({
  attempt,
}: {
  readonly attempt: Extract<ReferenceAttempt, { outcome: "response" }>;
}): ReactElement {
  const { body } = attempt;
  return (
    <>
      <p className={css.meta}>
        {referenceCopy.attempt.media}：
        <code>{attempt.contentType || referenceCopy.noBody}</code>
      </p>
      {body.kind === "binary" ? (
        <p className={css.body}>{referenceCopy.attempt.binary(body.bytes)}</p>
      ) : body.text === "" ? (
        <p className={css.body}>{referenceCopy.noBody}</p>
      ) : (
        <figure className={css.example}>
          <figcaption className={css.meta}>
            {referenceCopy.attempt.body}
          </figcaption>
          <pre className={styles.code}>
            <code>{body.text}</code>
          </pre>
          {body.truncated && (
            <p className={css.body}>
              {referenceCopy.attempt.truncated(displayLimitKibibytes)}
            </p>
          )}
        </figure>
      )}
    </>
  );
}

function RequestForm({
  operation,
  values,
  initial,
}: {
  readonly operation: ReferenceOperation;
  readonly values: ReferenceValues;
  readonly initial: ReferenceAttempt | null;
}): ReactElement {
  const [attempt, setAttempt] = useState(initial);
  const [sending, setSending] = useState(false);
  const latest = useRef<symbol | null>(null);
  const heading = `${operation.id}-attempt`;
  const result = `${operation.id}-response`;
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const request = Symbol();
    latest.current = request;
    const search: Record<string, string> = {};
    for (const [name, value] of new FormData(event.currentTarget))
      if (typeof value === "string") search[name] = value;
    setSending(true);
    const outcome = await attemptPlan(
      planReferenceRequest([operation], search),
      browserSender,
    );
    if (latest.current !== request) return;
    setSending(false);
    setAttempt(outcome);
  }
  return (
    <>
      <h4 id={heading} className={css.subheading}>
        {referenceCopy.attempt.heading}
      </h4>
      <form
        method="get"
        action={`/developers#${result}`}
        aria-labelledby={heading}
        className={css.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <input type="hidden" name={operationSearchKey} value={operation.id} />
        {operation.parameters.map((parameter) => (
          <Field
            key={parameter.name}
            operation={operation}
            parameter={parameter}
            value={values[parameter.name] ?? ""}
          />
        ))}
        <div className={`${styles.actions} ${css.submit}`}>
          <button
            type="submit"
            className={`${styles.button} ${styles.solid}`}
            aria-label={`${referenceCopy.attempt.submit}（${operationName(operation)}）`}
          >
            <Icon name="send" />
            {referenceCopy.attempt.submit}
          </button>
        </div>
      </form>
      <div id={result} className={css.attempt}>
        <output className={css.attemptStatus}>
          {statusLine(attempt, sending)}
        </output>
        {!sending && attempt?.outcome === "response" && (
          <AttemptBody attempt={attempt} />
        )}
      </div>
    </>
  );
}

function Operation({
  operation,
  origin,
  search,
  attempt,
}: {
  readonly operation: ReferenceOperation;
  readonly origin: string;
  readonly search: ReferenceSearch;
  readonly attempt: ReferenceAttempt | null;
}): ReactElement {
  const submitted = search[operationSearchKey] === operation.id;
  return (
    <section
      id={operation.id}
      aria-labelledby={`${operation.id}-heading`}
      className={css.operation}
    >
      <h3 id={`${operation.id}-heading`} className={css.operationHeading}>
        <span>{operation.method}</span>
        <code>{operation.path}</code>
      </h3>
      <p className={css.body}>{japaneseSummary(operation)}</p>
      {showsContractText && (
        <div lang="en" className={css.contract}>
          <p className={css.body}>{operation.summary}</p>
          {operation.description && (
            <p className={css.body}>{operation.description}</p>
          )}
        </div>
      )}
      <Parameters operation={operation} />
      <Responses operation={operation} />
      <Examples operation={operation} origin={origin} />
      <RequestForm
        operation={operation}
        values={
          submitted
            ? requestValues(operation, search)
            : exampleValues(operation)
        }
        initial={attempt?.operation === operation.id ? attempt : null}
      />
    </section>
  );
}

/** Renders the reference from the OpenAPI model, usable without JavaScript. */
export function ApiReference({
  model,
  origin,
  search,
  attempt,
}: {
  readonly model: ReferenceModel;
  readonly origin: string;
  readonly search: ReferenceSearch;
  readonly attempt: ReferenceAttempt | null;
}): ReactElement {
  return (
    <div className={css.reference} data-api-reference="">
      <Navigation model={model} />
      <div className={css.content}>
        {model.groups.map((group, index) => (
          <section
            key={group.tag}
            aria-labelledby={`group-${index}`}
            className={css.group}
          >
            <h2 id={`group-${index}`} className={css.groupHeading}>
              {referenceCopy.tags[group.tag] ?? group.tag}
            </h2>
            {group.operations.map((operation) => (
              <Operation
                key={operation.id}
                operation={operation}
                origin={origin}
                search={search}
                attempt={attempt}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

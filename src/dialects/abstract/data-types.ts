import { Blob } from 'node:buffer';
import util from 'util';
import dayjs from 'dayjs';
import isEqual from 'lodash/isEqual';
import isObject from 'lodash/isObject';
import type { Class } from 'type-fest';
import { ValidationErrorItem } from '../../errors';
import type { Falsy } from '../../generic/falsy';
import type { GeoJson, GeoJsonType } from '../../geo-json.js';
import { assertIsGeoJson } from '../../geo-json.js';
import type { BuiltModelAttributeColumOptions, ModelStatic, Rangable, RangePart } from '../../model.js';
import type { Sequelize } from '../../sequelize.js';
import { makeBufferFromTypedArray } from '../../utils/buffer.js';
import { isPlainObject, isString } from '../../utils/check.js';
import { isValidTimeZone } from '../../utils/dayjs.js';
import { joinSQLFragments } from '../../utils/join-sql-fragments';
import { parseBigInt, parseNumber } from '../../utils/parse-number.js';
import { validator as Validator } from '../../utils/validator-extras';
import type { HstoreRecord } from '../postgres/hstore.js';
import { isDataType, isDataTypeClass } from './data-types-utils.js';
import type { TableNameWithSchema } from './query-interface.js';
import type { AbstractDialect } from './index.js';

// TODO: try merging "validate" & "sanitize" by making sanitize coerces the type, and if it cannot, throw a ValidationError.
//       right now, they share a lot of the same logic.

// legacy support
let Moment: any;
try {
  Moment = require('moment');
} catch { /* ignore */ }

function isMoment(value: any): boolean {
  return Moment?.isMoment(value) ?? false;
}

// If T is a constructor, returns the type of what `new T()` would return,
// otherwise, returns T
export type Constructed<T> = T extends abstract new () => infer Instance
  ? Instance
  : T;

export type AcceptableTypeOf<T extends DataType> =
  Constructed<T> extends AbstractDataType<infer Acceptable> ? Acceptable : never;

export type DataTypeInstance = AbstractDataType<any>;
export type DataTypeClass = Class<AbstractDataType<any>>;

export type DataTypeClassOrInstance =
  | DataTypeInstance
  | DataTypeClass;

export type DataType =
  | string
  | DataTypeClassOrInstance;

export interface ToSqlOptions {
  dialect: AbstractDialect;
}

export interface StringifyOptions {
  dialect: AbstractDialect;
  escape(value: unknown): string;
  operation?: string;
  timezone?: string | undefined;
  field?: BuiltModelAttributeColumOptions;
}

export interface BindParamOptions extends StringifyOptions {
  bindParam(value: unknown): string;
}

export interface ParseOptions {
  dialect: AbstractDialect;
}

export type DataTypeUseContext =
  | { model: ModelStatic, attributeName: string, sequelize: Sequelize }
  | { tableName: TableNameWithSchema, columnName: string, sequelize: Sequelize };

/**
 * A symbol that can be used as the key for a static property on a DataType class to uniquely identify it.
 */
const kDataTypeIdentifier = Symbol('sequelize.DataTypeIdentifier');

export abstract class AbstractDataType<
  /** The type of value we'll accept - ie for a column of this type, we'll accept this value as user input. */
  AcceptedType,
> {
  /**
   * This property is designed to uniquely identify the DataType.
   * Do not change this value in implementation-specific dialects, or they will not be mapped to their parent DataType properly!
   *
   * @internal
   */
  declare static readonly [kDataTypeIdentifier]: string;

  static getDataTypeId(): string {
    return this[kDataTypeIdentifier];
  }

  getDataTypeId(): string {
    // @ts-expect-error untyped constructor
    return this.constructor.getDataTypeId();
  }

  /**
   * Where this DataType is being used.
   */
  usageContext: DataTypeUseContext | undefined;

  static get escape() {
    throw new Error('The "escape" static property has been removed. Each DataType is responsible for escaping its value correctly.');
  }

  static get types() {
    throw new Error('The "types" static property has been removed. Use getDataTypeDialectMeta.');
  }

  static get key() {
    throw new Error('The "key" static property has been removed.');
  }

  get types() {
    throw new Error('The "types" instance property has been removed.');
  }

  get key() {
    throw new Error('The "key" instance property has been removed.');
  }

  // TODO: move to utils?
  protected _construct<Constructor extends abstract new () => AbstractDataType<any>>(
    ...args: ConstructorParameters<Constructor>): this {
    const constructor = this.constructor as new (
      ..._args: ConstructorParameters<Constructor>
    ) => this;

    return new constructor(...args);
  }

  areValuesEqual(
    value: AcceptedType,
    originalValue: AcceptedType,
  ): boolean {
    return isEqual(value, originalValue);
  }

  /**
   * Used to parse a value when retrieved from the Database.
   * Parsers are based on the Database Type, not the JS type.
   * Only one JS DataType can be assigned as the parser for a Database Type.
   * For this reason, prefer neutral implementations.
   *
   * For instance, when implementing "parse" for a Date type,
   * prefer returning a String rather than a Date object.
   * The {@link sanitize} method will then be called on the DataType instance defined by the user,
   * which can decide on a more specific JS type (e.g. parse the date string & return a Date instance or a Temporal instance).
   *
   * If this method is implemented, you also need to register it with your dialect's {@link AbstractDialect#registerDataTypeParser} method.
   *
   * You typically do not need to implement this method. This is mainly used to provide default parsers when no DataType
   * is provided (e.g. raw queries that don't specify a model). Sequelize already provides a default parser for most types.
   * If you don't need this, implementing {@link sanitize} is sufficient.
   *
   * @param value The value to parse. This value is dialect specific.
   * @param _options Options.
   */
  parse(value: unknown, _options: ParseOptions): unknown {
    return value;
  }

  /**
   * Used to normalize a value when {@link Model#set} is called.
   * Typically, when populating a model instance from a database query.
   *
   * @param value
   */
  sanitize(value: unknown): unknown {
    return value;
  }

  /**
   * Checks whether the JS value is compatible with (or can be converted to) the SQL data type.
   * Throws if that is not the case.
   *
   * @param value
   */
  validate(value: any): asserts value is AcceptedType {}

  escape(value: AcceptedType, options: StringifyOptions): string {
    const asBindValue = this.toBindableValue(value, options);

    if (!isString(asBindValue)) {
      throw new Error(`${this.constructor.name}#stringify has been overridden to return a non-string value, so ${this.constructor.name}#escape must be implemented to handle that value correctly.`);
    }

    return options.dialect.escapeString(asBindValue);
  }

  /**
   * Transforms a value before adding it to the list of bind parameters of a query.
   *
   * @param value
   * @param options
   */
  bindParam(value: AcceptedType, options: BindParamOptions): string {
    return options.bindParam(this.toBindableValue(value, options));
  }

  /**
   * Converts a JS value to a SQL value, compatible with the SQL data type
   *
   * @param value
   * @param _options
   */
  toBindableValue(value: AcceptedType, _options: StringifyOptions): unknown {
    return String(value);
  }

  toString(): string {
    try {
      return this.toSql({ dialect: this.usageContext?.sequelize.dialect! });
    } catch {
      // best effort introspection (dialect may not be available)
      return this.constructor.toString();
    }
  }

  static toString() {
    return this.name;
  }

  /**
   * Returns a SQL declaration of this data type.
   * e.g. 'VARCHAR(255)', 'TEXT', etc…
   */
  abstract toSql(options: ToSqlOptions): string;

  /**
   * Override this method to emit an error or a warning if the Data Type, as it is configured, is not compatible
   * with the current dialect.
   *
   * @param dialect The dialect using this data type.
   * @protected
   * @internal
   */
  protected _checkOptionSupport(dialect: AbstractDialect) {
    // use "dialect.supports" to determine base support for this DataType.
    assertDataTypeSupported(dialect, this);
  }

  /**
   * Returns this DataType, using its dialect-specific subclass.
   *
   * @param dialect
   */
  toDialectDataType(dialect: AbstractDialect): this {
    const DataTypeClass = this.constructor as typeof AbstractDataType;
    const subClass = dialect.dataTypeOverrides.get(DataTypeClass.getDataTypeId()) as unknown as typeof AbstractDataType;

    if (!subClass || subClass === DataTypeClass) {
      this._checkOptionSupport(dialect);

      return this;
    }

    // @ts-expect-error
    const replacement = new subClass(this.options);
    replacement._checkOptionSupport(dialect);
    if (this.usageContext) {
      replacement.attachUsageContext(this.usageContext);
    }

    return replacement as this;
  }

  /**
   * Returns a copy of this DataType, without usage context.
   * Designed to re-use a DataType on another Model.
   */
  clone(): this {
    // @ts-expect-error
    return this._construct(this.options);
  }

  /**
   * @param usageContext
   * @internal
   */
  attachUsageContext(usageContext: DataTypeUseContext): this {
    if (this.usageContext && !isEqual(this.usageContext, usageContext)) {
      throw new Error(`This DataType is already attached to ${printContext(this.usageContext)}, and therefore cannot be attached to ${printContext(usageContext)}.`);
    }

    this.usageContext = Object.freeze(usageContext);

    return this;
  }
}

function printContext(usageContext: DataTypeUseContext): string {
  if ('model' in usageContext) {
    return `attribute ${usageContext.model.name}#${usageContext.attributeName}`;
  }

  return `column "${usageContext.tableName}"."${usageContext.columnName}"`;
}

export interface StringTypeOptions {
  /**
   * @default 255
   */
  length?: number | undefined;

  /**
   * @default false
   */
  binary?: boolean;
}

/**
 * STRING A variable length string
 */
export class STRING extends AbstractDataType<string | Buffer> {
  static readonly [kDataTypeIdentifier]: string = 'STRING';
  readonly options: StringTypeOptions;

  constructor(length: number, binary?: boolean);
  constructor(options?: StringTypeOptions);
  // we have to define the constructor overloads using tuples due to a TypeScript limitation
  //  https://github.com/microsoft/TypeScript/issues/29732, to play nice with classToInvokable.
  /** @internal */
  constructor(...args:
    | []
    | [length: number]
    | [length: number, binary: boolean]
    | [options: StringTypeOptions]
  );
  constructor(lengthOrOptions?: number | StringTypeOptions, binary?: boolean) {
    super();

    if (isObject(lengthOrOptions)) {
      this.options = {
        length: lengthOrOptions.length,
        binary: lengthOrOptions.binary ?? false,
      };
    } else {
      this.options = {
        length: lengthOrOptions,
        binary: binary ?? false,
      };
    }
  }

  toSql(_options: ToSqlOptions): string {
    // TODO: STRING should use an unlimited length type by default - https://github.com/sequelize/sequelize/issues/14259
    return joinSQLFragments([
      `VARCHAR(${this.options.length ?? 255})`,
      this.options.binary && 'BINARY',
    ]);
  }

  validate(value: any): asserts value is string | Buffer {
    if (typeof value === 'string') {
      return;
    }

    if (!this.options.binary) {
      ValidationErrorItem.throwDataTypeValidationError(
        `${util.inspect(value)} is not a valid string. Only the string type is accepted for non-binary strings.`,
      );
    }

    rejectBlobs(value);

    if (Buffer.isBuffer(value)) {
      return;
    }

    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return;
    }

    ValidationErrorItem.throwDataTypeValidationError(
      `${util.inspect(value)} is not a valid binary value: Only strings, Buffer, Uint8Array and ArrayBuffer are supported.`,
    );
  }

  get BINARY() {
    return this._construct<typeof STRING>({
      ...this.options,
      binary: true,
    });
  }

  static get BINARY() {
    return new this({ binary: true });
  }

  escape(value: string | Buffer, options: StringifyOptions): string {
    if (Buffer.isBuffer(value)) {
      return options.dialect.escapeBuffer(value);
    }

    return options.dialect.escapeString(value);
  }

  sanitize(value: unknown): unknown {
    if (this.options.binary) {
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        return makeBufferFromTypedArray(value);
      }

      if (typeof value === 'string') {
        return Buffer.from(value);
      }
    }

    return value;
  }
}

/**
 * CHAR A fixed length string
 */
export class CHAR extends STRING {
  static readonly [kDataTypeIdentifier]: string = 'CHAR';

  protected _checkOptionSupport(dialect: AbstractDialect) {
    super._checkOptionSupport(dialect);

    if (!dialect.supports.dataTypes.CHAR.BINARY && this.options.binary) {
      throwUnsupportedDataType(dialect, 'CHAR.BINARY');
    }
  }

  toSql() {
    return joinSQLFragments([
      `CHAR(${this.options.length ?? 255})`,
      this.options.binary && 'BINARY',
    ]);
  }
}

const validTextLengths = ['tiny', 'medium', 'long'];
export type TextLength = 'tiny' | 'medium' | 'long';

export interface TextOptions {
  length?: TextLength | undefined;
}

/**
 * Unlimited length TEXT column
 */
export class TEXT extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'TEXT';
  readonly options: TextOptions;

  /**
   * @param lengthOrOptions could be tiny, medium, long.
   */
  constructor(lengthOrOptions?: TextLength | TextOptions) {
    super();

    const length = (typeof lengthOrOptions === 'object' ? lengthOrOptions.length : lengthOrOptions)?.toLowerCase();

    if (length != null && !validTextLengths.includes(length)) {
      throw new TypeError(`If specified, the "length" option must be one of: ${validTextLengths.join(', ')}`);
    }

    this.options = {
      length: length as TextLength,
    };
  }

  toSql(): string {
    switch (this.options.length) {
      case 'tiny':
        return 'TINYTEXT';
      case 'medium':
        return 'MEDIUMTEXT';
      case 'long':
        return 'LONGTEXT';
      default:
        return 'TEXT';
    }
  }

  validate(value: any): asserts value is string {
    if (typeof value !== 'string') {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%s is not a valid string', value),
      );
    }
  }
}

/**
 * An unlimited length case-insensitive text column.
 * Original case is preserved but acts case-insensitive when comparing values (such as when finding or unique constraints).
 * Only available in Postgres and SQLite.
 */
export class CITEXT extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'CITEXT';

  toSql(): string {
    return 'CITEXT';
  }

  validate(value: any): asserts value is string {
    if (typeof value !== 'string') {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%s is not a valid string', value),
      );
    }
  }
}

export interface NumberOptions {
  /**
   * length of type, like `INT(4)`
   */
  length?: number | undefined;

  /**
   * number of decimal points, used with length `FLOAT(5, 4)`
   */
  decimals?: number | undefined;

  /**
   * Is zero filled?
   */
  zerofill?: boolean | undefined;

  /**
   * Is unsigned?
   */
  unsigned?: boolean | undefined;
}

type AcceptedNumber =
  | number
  | bigint
  | boolean
  | string
  | null;

/**
 * Base number type which is used to build other types
 */
export class NUMBER<Options extends NumberOptions = NumberOptions> extends AbstractDataType<AcceptedNumber> {
  readonly options: Options;

  constructor(optionsOrLength?: number | Readonly<Options>) {
    super();

    if (isObject(optionsOrLength)) {
      this.options = { ...optionsOrLength };
    } else {
      // @ts-expect-error
      this.options = { length: optionsOrLength };
    }
  }

  protected getNumberSqlTypeName(): string {
    throw new Error(`getNumberSqlTypeName has not been implemented in ${this.constructor.name}`);
  }

  toSql(_options: ToSqlOptions): string {
    let result: string = this.getNumberSqlTypeName();
    if (!result) {
      throw new Error('toSql called on a NUMBER DataType that did not declare its key property.');
    }

    if (this.options.length) {
      result += `(${this.options.length}`;
      if (typeof this.options.decimals === 'number') {
        result += `,${this.options.decimals}`;
      }

      result += ')';
    }

    if (this.options.unsigned) {
      result += ' UNSIGNED';
    }

    if (this.options.zerofill) {
      result += ' ZEROFILL';
    }

    return result;
  }

  validate(value: any): asserts value is number {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format(`${this.constructor.name} received an integer % that is not a safely represented using the JavaScript number type. Use a JavaScript bigint or a string instead.`, value),
      );
    }

    if (!Validator.isFloat(String(value))) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format(
          `%s is not a valid ${
            super.toString()
              .toLowerCase()}`,
          value,
        ),
      );
    }
  }

  escape(value: AcceptedNumber, options: StringifyOptions): string {
    return this.toBindableValue(value, options);
  }

  toBindableValue(number: AcceptedNumber, _options: StringifyOptions): string {
    // This should be unnecessary but since this directly returns the passed string its worth the added validation.
    this.validate(number);

    return String(number);
  }

  bindParam(value: AcceptedNumber, options: BindParamOptions): string {
    return options.bindParam(value);
  }

  get UNSIGNED(): this {
    return this._construct<typeof NUMBER>({ ...this.options, unsigned: true });
  }

  get ZEROFILL(): this {
    return this._construct<typeof NUMBER>({ ...this.options, zerofill: true });
  }

  static get UNSIGNED() {
    return new this({ unsigned: true });
  }

  static get ZEROFILL() {
    return new this({ zerofill: true });
  }
}

/**
 * A 32 bit integer
 */
export class INTEGER extends NUMBER {
  static readonly [kDataTypeIdentifier]: string = 'INTEGER';

  validate(value: unknown) {
    super.validate(value);

    if (typeof value === 'number' && !Number.isInteger(value)) {
      ValidationErrorItem.throwDataTypeValidationError(`${util.inspect(value)} is not a valid integer`);
    }

    if (!Validator.isInt(String(value))) {
      ValidationErrorItem.throwDataTypeValidationError(`${util.inspect(value)} is not a valid integer`);
    }
  }

  sanitize(value: unknown): unknown {
    if (typeof value === 'string' || typeof value === 'bigint') {
      const out = parseNumber(value);

      // let validate sort this validation instead
      if (Number.isNaN(out)) {
        return value;
      }

      return out;
    }

    return value;
  }

  protected getNumberSqlTypeName(): string {
    return 'INTEGER';
  }

  parse(value: unknown) {
    return this.sanitize(value);
  }
}

/**
 * A 8 bit integer
 */
export class TINYINT extends INTEGER {
  static readonly [kDataTypeIdentifier]: string = 'TINYINT';

  protected getNumberSqlTypeName(): string {
    return 'TINYINT';
  }
}

/**
 * A 16 bit integer
 */
export class SMALLINT extends INTEGER {
  static readonly [kDataTypeIdentifier]: string = 'SMALLINT';

  protected getNumberSqlTypeName(): string {
    return 'SMALLINT';
  }
}

/**
 * A 24 bit integer
 */
export class MEDIUMINT extends INTEGER {
  static readonly [kDataTypeIdentifier]: string = 'MEDIUMINT';

  protected getNumberSqlTypeName(): string {
    return 'MEDIUMINT';
  }
}

/**
 * A 64 bit integer
 */
export class BIGINT extends INTEGER {
  static readonly [kDataTypeIdentifier]: string = 'BIGINT';

  protected getNumberSqlTypeName(): string {
    return 'BIGINT';
  }

  sanitize(value: unknown): unknown {
    if (typeof value === 'bigint') {
      return value;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      // let validate() handle this instead
      return value;
    }

    // TODO: Breaking Change: Return a BigInt by default - https://github.com/sequelize/sequelize/issues/14296
    return String(parseBigInt(value));
  }
}

/**
 * Floating point number (4-byte precision).
 */
export class FLOAT extends NUMBER {
  static readonly [kDataTypeIdentifier]: string = 'FLOAT';

  constructor(options?: NumberOptions);

  // TODO: the description of length is not accurate
  //  mysql/mariadb: float(M,D) M is the total number of digits and D is the number of digits following the decimal point.
  //  postgres/mssql: float(P) is the precision
  /**
   * @param length length of type, like `FLOAT(4)`
   * @param decimals number of decimal points, used with length `FLOAT(5, 4)`
   */
  constructor(length: number, decimals?: number);
  // we have to define the constructor overloads using tuples due to a TypeScript limitation
  //  https://github.com/microsoft/TypeScript/issues/29732, to play nice with classToInvokable.
  /** @internal */
  constructor(...args: [length: number, decimals?: number] | [options?: NumberOptions]);
  constructor(length?: number | NumberOptions, decimals?: number) {
    super(typeof length === 'object' ? length : { length, decimals });
  }

  validate(value: any): asserts value is AcceptedNumber {
    // Float is IEEE 754 floating point number, which supports NaN, Infinity, and -Infinity.
    // If your dialect does not accept these types, override this method to reject them.
    if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) {
      return;
    }

    if (!Validator.isFloat(String(value))) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid float', value),
      );
    }
  }

  toBindableValue(value: AcceptedNumber) {
    const num = typeof value === 'number' ? value : Number(String(value));

    if (Number.isNaN(num)) {
      return 'NaN';
    }

    if (!Number.isFinite(num)) {
      const sign = num < 0 ? '-' : '';

      return `${sign}Infinity`;
    }

    return num.toString();
  }

  protected getNumberSqlTypeName(): string {
    return 'FLOAT';
  }
}

export class REAL extends FLOAT {
  static readonly [kDataTypeIdentifier]: string = 'REAL';

  protected getNumberSqlTypeName(): string {
    return 'REAL';
  }
}

/**
 * Floating point number (8-byte precision).
 */
export class DOUBLE extends FLOAT {
  static readonly [kDataTypeIdentifier]: string = 'DOUBLE';

  protected getNumberSqlTypeName(): string {
    return 'DOUBLE';
  }
}

export interface DecimalOptions extends NumberOptions {
  scale?: number | undefined;
  precision?: number | undefined;
}

/**
 * Decimal type, variable precision, take length as specified by user
 */
export class DECIMAL extends NUMBER<DecimalOptions> {
  static readonly [kDataTypeIdentifier]: string = 'DECIMAL';

  constructor(options?: DecimalOptions);
  /**
   * @param precision defines precision
   * @param scale defines scale
   */
  constructor(precision: number, scale: number);

  // we have to define the constructor overloads using tuples due to a TypeScript limitation
  //  https://github.com/microsoft/TypeScript/issues/29732, to play nice with classToInvokable.
  /** @internal */
  constructor(...args:
    | []
    | [precision: number]
    | [precision: number, scale: number]
    | [options: DecimalOptions]
  );

  constructor(precisionOrOptions?: number | DecimalOptions, scale?: number) {
    if (isObject(precisionOrOptions)) {
      super(precisionOrOptions);
    } else {
      super();

      this.options.precision = precisionOrOptions;
      this.options.scale = scale;
    }

    if (this.options.scale != null && this.options.precision == null) {
      throw new Error('The DECIMAL DataType requires that the "precision" option be specified if the "scale" option is specified.');
    }

    if (this.options.scale == null && this.options.precision != null) {
      throw new Error('The DECIMAL DataType requires that the "scale" option be specified if the "precision" option is specified.');
    }
  }

  protected _checkOptionSupport(dialect: AbstractDialect) {
    super._checkOptionSupport(dialect);

    if (this.isUnconstrained() && !dialect.supports.dataTypes.DECIMAL.unconstrained) {
      throw new Error(`${dialect.name} does not support unconstrained DECIMAL types. Please specify the "precision" and "scale" options.`);
    }
  }

  isUnconstrained() {
    return this.options.scale == null && this.options.precision == null;
  }

  toSql(_options?: ToSqlOptions): string {
    if (this.isUnconstrained()) {
      return 'DECIMAL';
    }

    return `DECIMAL(${this.options.precision}, ${this.options.scale})`;
  }
}

/**
 * A boolean / tinyint column, depending on dialect
 */
export class BOOLEAN extends AbstractDataType<boolean | Falsy> {
  static readonly [kDataTypeIdentifier]: string = 'BOOLEAN';

  toSql() {
    // Note: This may vary depending on the dialect.
    return 'BOOLEAN';
  }

  validate(value: any): asserts value is boolean {
    if (typeof value !== 'boolean') {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid boolean', value),
      );
    }
  }

  sanitize(value: unknown): unknown {
    // Because MySQL doesn't have a real boolean type, we can't call "parse" on it.
    // As a result, we're forced to accept 1 & 0 as valid values that will be converted to true & false.
    // TODO: Add a "sanitizeDatabaseValue" method that is only called on values that come from the Database, and a
    //       "sanitizeUserValue" method that is only called on values that come from the user.
    //       This requires reworking how Model#set works, as it currently calls sanitize on all values, regardless of
    //       where they came from.
    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }

      if (value === 0) {
        return false;
      }
    }

    // MySQL also accepts BIT(1) for booleans, which produces a Buffer. For the same reasons as above, we must
    // transform it here.
    if (Buffer.isBuffer(value) && value.length === 1) {
      if (value[0] === 1) {
        return true;
      }

      if (value[0] === 0) {
        return false;
      }
    }

    return value;
  }

  // this type is not sanitized: Only true & false are allowed as user inputs
  // it is parsed: DBs represent booleans in a variety of ways.

  parse(value: unknown): unknown {
    if (Buffer.isBuffer(value) && value.length === 1) {
      // Bit fields are returned as buffers
      value = value[0];
    }

    const type = typeof value;
    if (type === 'boolean') {
      return value;
    }

    if (type === 'string') {
      // Only take action on valid boolean strings.
      if (value === 'true' || value === '1' || value === 't') {
        return true;
      }

      if (value === 'false' || value === '0' || value === 'f') {
        return false;
      }

      // Only take action on valid boolean integers.
    } else if (typeof value === 'bigint') {
      if (value === 1n) {
        return true;
      }

      if (value === 0n) {
        return false;
      }
    }

    throw new Error(`Cannot parse ${util.inspect(value)} as a boolean`);
  }

  escape(value: boolean | Falsy): string {
    return value ? 'true' : 'false';
  }

  toBindableValue(value: boolean | Falsy): unknown {
    return value ? 'true' : 'false';
  }
}

export interface TimeOptions {
  /**
   * The precision of the date.
   */
  precision?: string | number | undefined;
}

/**
 * A time column
 */
export class TIME extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'TIME';
  readonly options: TimeOptions;

  /**
   * @param precisionOrOptions precision to allow storing milliseconds
   */
  constructor(precisionOrOptions?: number | TimeOptions) {
    super();

    this.options = {
      precision: (typeof precisionOrOptions === 'object' ? precisionOrOptions.precision : precisionOrOptions) ?? 0,
    };
  }

  toSql() {
    if (this.options.precision != null) {
      return `TIME(${this.options.precision})`;
    }

    return 'TIME';
  }
}

export interface DateOptions {
  /**
   * The precision of the date.
   */
  precision?: string | number | undefined;
}

type RawDate = Date | string | number;
export type AcceptedDate = RawDate | dayjs.Dayjs | number;

/**
 * A date and time.
 */
export class DATE extends AbstractDataType<AcceptedDate> {
  static readonly [kDataTypeIdentifier]: string = 'DATE';
  readonly options: DateOptions;

  /**
   * @param precisionOrOptions precision to allow storing milliseconds
   */
  constructor(precisionOrOptions?: number | DateOptions) {
    super();

    this.options = {
      precision: typeof precisionOrOptions === 'object' ? precisionOrOptions.precision : precisionOrOptions,
    };
  }

  toSql() {
    if (this.options.precision != null) {
      return `DATETIME(${this.options.precision})`;
    }

    return 'DATETIME';
  }

  validate(value: any) {
    if (!Validator.isDate(String(value))) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid date', value),
      );
    }
  }

  sanitize(value: unknown): unknown {
    if (value instanceof Date || dayjs.isDayjs(value) || isMoment(value)) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      return new Date(value);
    }

    throw new TypeError(`${util.inspect(value)} cannot be converted to a Date object, and is not a DayJS nor Moment object`);
  }

  areValuesEqual(
    value: AcceptedDate,
    originalValue: AcceptedDate,
  ): boolean {
    if (
      originalValue
      && Boolean(value)
      && (value === originalValue
        || (value instanceof Date
          && originalValue instanceof Date
          && value.getTime() === originalValue.getTime()))
    ) {
      return true;
    }

    // not changed when set to same empty value
    if (!originalValue && !value && originalValue === value) {
      return true;
    }

    return false;
  }

  protected _applyTimezone(date: AcceptedDate, options: { timezone?: string | undefined }) {
    if (options.timezone) {
      if (isValidTimeZone(options.timezone)) {
        return dayjs(date).tz(options.timezone);
      }

      return dayjs(date).utcOffset(options.timezone);
    }

    return dayjs(date);
  }

  toBindableValue(
    date: AcceptedDate,
    options: StringifyOptions,
  ) {
    // Z here means current timezone, _not_ UTC
    return this._applyTimezone(date, options).format('YYYY-MM-DD HH:mm:ss.SSS Z');
  }
}

/**
 * A date only column (no timestamp)
 */
export class DATEONLY extends AbstractDataType<AcceptedDate> {
  static readonly [kDataTypeIdentifier]: string = 'DATEONLY';

  toSql() {
    return 'DATE';
  }

  toBindableValue(date: AcceptedDate, _options: StringifyOptions) {
    return dayjs(date).format('YYYY-MM-DD');
  }

  sanitize(value: unknown): unknown {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
      throw new TypeError(`${value} cannot be normalized into a DateOnly string.`);
    }

    if (value) {
      return dayjs(value).format('YYYY-MM-DD');
    }

    return value;
  }

  areValuesEqual(value: AcceptedDate, originalValue: AcceptedDate): boolean {
    if (originalValue && Boolean(value) && originalValue === value) {
      return true;
    }

    // not changed when set to same empty value
    if (!originalValue && !value && originalValue === value) {
      return true;
    }

    return false;
  }
}

/**
 * A key / value store column. Only available in Postgres.
 */
export class HSTORE extends AbstractDataType<HstoreRecord> {
  static readonly [kDataTypeIdentifier]: string = 'HSTORE';

  validate(value: any) {
    if (!isPlainObject(value)) {
      ValidationErrorItem.throwDataTypeValidationError(util.format('%O is not a valid hstore, it must be a plain object', value));
    }

    for (const key of Object.keys(value)) {
      if (!isString(value[key])) {
        ValidationErrorItem.throwDataTypeValidationError(util.format(`%O is not a valid hstore, its values must be strings but ${key} is %O`, value, value[key]));
      }
    }
  }

  toSql(): string {
    return 'HSTORE';
  }
}

/**
 * A JSON string column.
 */
export class JSON extends AbstractDataType<any> {
  static readonly [kDataTypeIdentifier]: string = 'JSON';

  toBindableValue(value: any): string {
    return globalThis.JSON.stringify(value);
  }

  toSql(): string {
    return 'JSON';
  }
}

/**
 * A binary storage JSON column. Only available in Postgres.
 */
export class JSONB extends JSON {
  static readonly [kDataTypeIdentifier]: string = 'JSONB';

  toSql(): string {
    return 'JSONB';
  }
}

/**
 * A default value of the current timestamp.  Not a valid type.
 */
// TODO: this should not be a DataType. Replace with a new version of `fn` that is dialect-aware, so we don't need to hardcode it in toDefaultValue().
export class NOW extends AbstractDataType<never> {
  static readonly [kDataTypeIdentifier]: string = 'NOW';

  toSql(): string {
    return 'NOW';
  }
}

export type AcceptedBlob = Buffer | string;

export type BlobLength = 'tiny' | 'medium' | 'long';

export interface BlobOptions {
  // TODO: must also allow BLOB(255), BLOB(16M) in db2/ibmi
  length?: BlobLength | undefined;
}

/**
 * Binary storage
 */
export class BLOB extends AbstractDataType<AcceptedBlob> {
  static readonly [kDataTypeIdentifier]: string = 'BLOB';
  readonly options: BlobOptions;

  /**
   * @param lengthOrOptions could be tiny, medium, long.
   */
  constructor(lengthOrOptions?: BlobLength | BlobOptions) {
    super();

    // TODO: valide input (tiny, medium, long, number, 16M, 2G, etc)

    this.options = {
      length: typeof lengthOrOptions === 'object' ? lengthOrOptions.length : lengthOrOptions,
    };
  }

  toSql(): string {
    switch (this.options.length) {
      case 'tiny':
        return 'TINYBLOB';
      case 'medium':
        return 'MEDIUMBLOB';
      case 'long':
        return 'LONGBLOB';
      default:
        return 'BLOB';
    }
  }

  validate(value: any) {
    if (Buffer.isBuffer(value) || typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return;
    }

    rejectBlobs(value);

    ValidationErrorItem.throwDataTypeValidationError(
      `${util.inspect(value)} is not a valid binary value: Only strings, Buffer, Uint8Array and ArrayBuffer are supported.`,
    );
  }

  sanitize(value: unknown): unknown {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return makeBufferFromTypedArray(value);
    }

    return value;
  }

  escape(value: string | Buffer, options: StringifyOptions) {
    const buf = typeof value === 'string' ? Buffer.from(value, 'binary') : value;

    return options.dialect.escapeBuffer(buf);
  }

  bindParam(value: AcceptedBlob, options: BindParamOptions) {
    return options.bindParam(value);
  }
}

export interface RangeOptions {
  subtype?: DataTypeClassOrInstance;
}

/**
 * Range types are data types representing a range of values of some element type (called the range's subtype).
 * Only available in Postgres. See [the Postgres documentation](http://www.postgresql.org/docs/9.4/static/rangetypes.html) for more details
 */
export class RANGE<T extends NUMBER | DATE | DATEONLY = INTEGER> extends AbstractDataType<
  Rangable<AcceptableTypeOf<T>> | AcceptableTypeOf<T>
> {
  static readonly [kDataTypeIdentifier]: string = 'RANGE';
  readonly options: {
    subtype: AbstractDataType<any>,
  };

  /**
   * @param subtypeOrOptions A subtype for range, like RANGE(DATE)
   */
  constructor(subtypeOrOptions: DataTypeClassOrInstance | RangeOptions) {
    super();

    const subtypeRaw = (isDataType(subtypeOrOptions) ? subtypeOrOptions : subtypeOrOptions?.subtype)
      ?? new INTEGER();

    const subtype: DataTypeInstance = isDataTypeClass(subtypeRaw)
      ? new subtypeRaw()
      : subtypeRaw;

    this.options = {
      subtype,
    };
  }

  toDialectDataType(dialect: AbstractDialect): this {
    let replacement = super.toDialectDataType(dialect);

    if (replacement === this) {
      replacement = replacement.clone();
    }

    replacement.options.subtype = replacement.options.subtype.toDialectDataType(dialect);

    return replacement;
  }

  sanitize(value: unknown): unknown {
    if (!Array.isArray(value)) {
      return value;
    }

    // this is the "empty" range, which is not the same value as "(,)" (represented by [null, null])
    if (value.length === 0) {
      return value;
    }

    let [low, high] = value;
    if (!isPlainObject(low)) {
      low = { value: low ?? null, inclusive: true };
    }

    if (!isPlainObject(high)) {
      high = { value: high ?? null, inclusive: false };
    }

    return [this.#sanitizeSide(low), this.#sanitizeSide(high)];
  }

  #sanitizeSide(rangePart: RangePart<unknown>) {
    if (rangePart.value == null) {
      return rangePart;
    }

    return { ...rangePart, value: this.options.subtype.sanitize(rangePart.value) };
  }

  validate(value: any) {
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 0)) {
      ValidationErrorItem.throwDataTypeValidationError(
        'A range must either be an array with two elements, or an empty array for the empty range.',
      );
    }
  }

  toSql(): string {
    throw new Error('RANGE has not been implemented in this dialect.');
  }
}

/**
 * A column storing a unique universal identifier.
 * Use with `UUIDV1` or `UUIDV4` for default values.
 */
export class UUID extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'UUID';

  validate(value: any) {
    if (typeof value !== 'string' || !Validator.isUUID(value)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid uuid', value),
      );
    }
  }

  toSql(): string {
    return 'UUID';
  }
}

/**
 * A default unique universal identifier generated following the UUID v1 standard
 */
// TODO: this should not be a DataType. Replace with a new version of `fn` that is dialect-aware, so we don't need to hardcode it in toDefaultValue().
export class UUIDV1 extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'UUIDV1';

  validate(value: any) {
    // @ts-expect-error -- the typings for isUUID are missing '1' as a valid uuid version, but its implementation does accept it
    if (typeof value !== 'string' || !Validator.isUUID(value, 1)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid uuidv1', value),
      );
    }
  }

  toSql(): string {
    throw new Error('toSQL should not be called on DataTypes.UUIDV1');
  }
}

/**
 * A default unique universal identifier generated following the UUID v4 standard
 */
// TODO: this should not be a DataType. Replace with a new version of `fn` that is dialect-aware, so we don't need to hardcode it in toDefaultValue().
export class UUIDV4 extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'UUIDV4';

  validate(value: unknown) {
    if (typeof value !== 'string' || !Validator.isUUID(value, 4)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid uuidv4', value),
      );
    }
  }

  toSql(): string {
    throw new Error('toSQL should not be called on DataTypes.UUIDV4');
  }
}

export interface VirtualOptions {
  returnType?: DataTypeClassOrInstance | undefined;
  attributeDependencies?: string[] | undefined;
}

export interface NormalizedVirtualOptions {
  returnType: DataTypeClassOrInstance | undefined;
  attributeDependencies: string[];
}

/**
 * A virtual value that is not stored in the DB. This could for example be useful if you want to provide a default value in your model that is returned to the user but not stored in the DB.
 *
 * You could also use it to validate a value before permuting and storing it. VIRTUAL also takes a return type and dependency fields as arguments
 * If a virtual attribute is present in `attributes` it will automatically pull in the extra fields as well.
 * Return type is mostly useful for setups that rely on types like GraphQL.
 *
 * @example <caption>Checking password length before hashing it</caption>
 * sequelize.define('user', {
 *   password_hash: DataTypes.STRING,
 *   password: {
 *     type: DataTypes.VIRTUAL,
 *     set: function (val) {
 *        // Remember to set the data value, otherwise it won't be validated
 *        this.setDataValue('password', val);
 *        this.setDataValue('password_hash', this.salt + val);
 *      },
 *      validate: {
 *         isLongEnough: function (val) {
 *           if (val.length < 7) {
 *             throw new Error("Please choose a longer password")
 *          }
 *       }
 *     }
 *   }
 * })
 *
 * # In the above code the password is stored plainly in the password field so it can be validated, but is never stored in the DB.
 *
 * @example <caption>Virtual with dependency fields</caption>
 * {
 *   active: {
 *     type: new DataTypes.VIRTUAL(DataTypes.BOOLEAN, ['createdAt']),
 *     get: function() {
 *       return this.get('createdAt') > Date.now() - (7 * 24 * 60 * 60 * 1000)
 *     }
 *   }
 * }
 *
 */
export class VIRTUAL<T> extends AbstractDataType<T> {
  static readonly [kDataTypeIdentifier]: string = 'VIRTUAL';

  options: NormalizedVirtualOptions;

  constructor(returnType?: DataTypeClassOrInstance, attributeDependencies?: string[]);
  constructor(options?: VirtualOptions);

  // we have to define the constructor overloads using tuples due to a TypeScript limitation
  //  https://github.com/microsoft/TypeScript/issues/29732, to play nice with classToInvokable.
  /** @internal */
  constructor(...args:
    | [returnType?: DataTypeClassOrInstance, attributeDependencies?: string[]]
    | [options?: VirtualOptions]
  );

  /**
   * @param [returnTypeOrOptions] return type for virtual type, or an option bag
   * @param [attributeDependencies] array of attributes this virtual type is dependent on
   */
  constructor(returnTypeOrOptions?: DataTypeClassOrInstance | VirtualOptions, attributeDependencies?: string[]) {
    super();

    const returnType = returnTypeOrOptions == null ? undefined
      : isDataType(returnTypeOrOptions) ? returnTypeOrOptions
      : returnTypeOrOptions.returnType;

    this.options = {
      returnType: typeof returnType === 'function' ? new returnType() : returnType,
      attributeDependencies: (isDataType(returnTypeOrOptions)
        ? attributeDependencies
        : returnTypeOrOptions?.attributeDependencies) ?? [],
    };
  }

  toSql(): string {
    throw new Error('toSQL should not be called on DataTypes.VIRTUAL');
  }

  get returnType() {
    return this.options.returnType;
  }

  get attributeDependencies() {
    return this.options.attributeDependencies;
  }
}

export interface EnumOptions<Member extends string> {
  values: Member[];
}

/**
 * An enumeration, Postgres Only
 *
 * @example
 * DataTypes.ENUM('value', 'another value')
 * DataTypes.ENUM(['value', 'another value'])
 * DataTypes.ENUM({
 *   values: ['value', 'another value']
 * });
 */
export class ENUM<Member extends string> extends AbstractDataType<Member> {
  static readonly [kDataTypeIdentifier]: string = 'ENUM';
  readonly options: EnumOptions<Member>;

  /**
   * @param options either array of values or options object with values array. It also supports variadic values.
   */
  constructor(options: EnumOptions<Member>);
  constructor(members: Member[]);
  constructor(...members: Member[]);
  // we have to define the constructor overloads using tuples due to a TypeScript limitation
  //  https://github.com/microsoft/TypeScript/issues/29732, to play nice with classToInvokable.
  /** @internal */
  constructor(...args:
    | [options: EnumOptions<Member>]
    | [members: Member[]]
    | [...members: Member[]]
  );
  constructor(...args: [Member[] | Member | EnumOptions<Member>, ...Member[]]) {
    super();

    let values: Member[];
    if (isObject(args[0])) {
      if (args.length > 1) {
        throw new TypeError('DataTypes.ENUM has been constructed incorrectly: Its first parameter is the option bag or the array of values, but more than one parameter has been provided.');
      }

      if (Array.isArray(args[0])) {
        values = args[0];
      } else {
        values = args[0].values;
      }
    } else {
      // @ts-expect-error -- we'll assert in the next line whether this is the right type
      values = args;
    }

    if (values.length === 0) {
      throw new TypeError('DataTypes.ENUM cannot be used without specifying its possible enum values.');
    }

    for (const value of values) {
      if (typeof value !== 'string') {
        throw new TypeError(util.format(`One of the possible values passed to DataTypes.ENUM (%O) is not a string. Only strings can be used as enum values.`, value));
      }
    }

    this.options = {
      values,
    };
  }

  validate(value: any): asserts value is Member {
    if (!this.options.values.includes(value)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid choice for enum %O', value, this.options.values),
      );
    }
  }

  toSql(options: ToSqlOptions): string {
    throw new Error(`ENUM has not been implemented in the ${options.dialect.name} dialect.`);
  }
}

export interface ArrayOptions {
  type: DataTypeClassOrInstance;
}

interface NormalizedArrayOptions {
  type: AbstractDataType<any>;
}

/**
 * An array of `type`. Only available in Postgres.
 *
 * @example
 * DataTypes.ARRAY(DataTypes.DECIMAL)
 */
export class ARRAY<T extends AbstractDataType<any>> extends AbstractDataType<Array<AcceptableTypeOf<T>>> {
  static readonly [kDataTypeIdentifier]: string = 'ARRAY';
  readonly options: NormalizedArrayOptions;

  /**
   * @param typeOrOptions type of array values
   */
  constructor(typeOrOptions: DataTypeClassOrInstance | ArrayOptions) {
    super();

    const rawType = isDataType(typeOrOptions) ? typeOrOptions : typeOrOptions?.type;

    if (!rawType) {
      throw new TypeError('DataTypes.ARRAY is missing type definition for its values.');
    }

    this.options = {
      type: typeof rawType === 'function' ? new rawType() : rawType,
    };
  }

  toSql(options: ToSqlOptions): string {
    return `${this.options.type.toSql(options)}[]`;
  }

  validate(value: any) {
    if (!Array.isArray(value)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid array', value),
      );
    }

    for (const item of value) {
      this.options.type.validate(item);
    }
  }

  sanitize(value: unknown): unknown {
    if (!Array.isArray(value)) {
      return value;
    }

    return value.map(item => this.options.type.sanitize(item));
  }

  toBindableValue(value: Array<AcceptableTypeOf<T>>, _options: StringifyOptions): string {
    // @ts-expect-error
    return value.map(val => this.options.type.toBindableValue(val, _options));
  }

  toDialectDataType(dialect: AbstractDialect): this {
    let replacement = super.toDialectDataType(dialect);

    if (replacement === this) {
      replacement = replacement.clone();
    }

    replacement.options.type = replacement.options.type.toDialectDataType(dialect);

    return replacement;
  }

  attachUsageContext(usageContext: DataTypeUseContext): this {
    this.options.type.attachUsageContext(usageContext);

    return super.attachUsageContext(usageContext);
  }

  static is<T extends AbstractDataType<any>>(
    obj: unknown,
    type: new () => T,
  ): obj is ARRAY<T> {
    return obj instanceof ARRAY && (obj).options.type instanceof type;
  }
}

export interface GeometryOptions {
  type?: GeoJsonType | undefined;
  srid?: number | undefined;
}

/**
 * A column storing Geometry information.
 * It is only available in PostgreSQL (with PostGIS), MariaDB or MySQL.
 *
 * GeoJSON is accepted as input and returned as output.
 *
 * In PostGIS, the GeoJSON is parsed using the PostGIS function `STGeomFromGeoJSON`.
 * In MySQL it is parsed using the function `STGeomFromText`.
 *
 * Therefore, one can just follow the [GeoJSON spec](https://tools.ietf.org/html/rfc7946) for handling geometry objects.  See the following examples:
 *
 * @example <caption>Defining a Geometry type attribute</caption>
 * DataTypes.GEOMETRY
 * DataTypes.GEOMETRY('POINT')
 * DataTypes.GEOMETRY('POINT', 4326)
 *
 * @example <caption>Create a new point</caption>
 * const point = { type: 'Point', coordinates: [-76.984722, 39.807222]}; // GeoJson format: [lng, lat]
 *
 * User.create({username: 'username', geometry: point });
 *
 * @example <caption>Create a new linestring</caption>
 * const line = { type: 'LineString', 'coordinates': [ [100.0, 0.0], [101.0, 1.0] ] };
 *
 * User.create({username: 'username', geometry: line });
 *
 * @example <caption>Create a new polygon</caption>
 * const polygon = { type: 'Polygon', coordinates: [
 *                 [ [100.0, 0.0], [101.0, 0.0], [101.0, 1.0],
 *                   [100.0, 1.0], [100.0, 0.0] ]
 *                 ]};
 *
 * User.create({username: 'username', geometry: polygon });
 *
 * @example <caption>Create a new point with a custom SRID</caption>
 * const point = {
 *   type: 'Point',
 *   coordinates: [-76.984722, 39.807222], // GeoJson format: [lng, lat]
 *   crs: { type: 'name', properties: { name: 'EPSG:4326'} }
 * };
 *
 * User.create({username: 'username', geometry: point })
 *
 *
 * @see {@link DataTypes.GEOGRAPHY}
 */
export class GEOMETRY extends AbstractDataType<GeoJson> {
  static readonly [kDataTypeIdentifier]: string = 'GEOMETRY';
  readonly options: GeometryOptions;

  /**
   * @param {string} [type] Type of geometry data
   * @param {string} [srid] SRID of type
   */
  constructor(type: GeoJsonType, srid?: number);
  constructor(options: GeometryOptions);

  // we have to define the constructor overloads using tuples due to a TypeScript limitation
  //  https://github.com/microsoft/TypeScript/issues/29732, to play nice with classToInvokable.
  /** @internal */
  constructor(...args:
    | [type: GeoJsonType, srid?: number]
    | [options: GeometryOptions]
  );

  constructor(typeOrOptions: GeoJsonType | GeometryOptions, srid?: number) {
    super();

    this.options = isObject(typeOrOptions)
      ? { ...typeOrOptions }
      : { type: typeOrOptions, srid };
  }

  validate(value: unknown): asserts value is GeoJson {
    try {
      assertIsGeoJson(value);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      // TODO: add 'cause'
      ValidationErrorItem.throwDataTypeValidationError(error.message);
    }

    return super.validate(value);
  }

  toSql(): string {
    return 'GEOMETRY';
  }
}

/**
 * A geography datatype represents two dimensional spacial objects in an elliptic coord system.
 *
 * **The difference from geometry and geography type:**
 *
 * PostGIS 1.5 introduced a new spatial type called geography, which uses geodetic measurement instead of Cartesian measurement.
 * Coordinate points in the geography type are always represented in WGS 84 lon lat degrees (SRID 4326),
 * but measurement functions and relationships STDistance, STDWithin, STLength, and STArea always return answers in meters or assume inputs in meters.
 *
 * **What is best to use? It depends:**
 *
 * When choosing between the geometry and geography type for data storage, you should consider what you’ll be using it for.
 * If all you do are simple measurements and relationship checks on your data, and your data covers a fairly large area, then most likely you’ll be better off storing your data using the new geography type.
 * Although the new geography data type can cover the globe, the geometry type is far from obsolete.
 * The geometry type has a much richer set of functions than geography, relationship checks are generally faster, and it has wider support currently across desktop and web-mapping tools
 *
 * @example <caption>Defining a Geography type attribute</caption>
 * DataTypes.GEOGRAPHY
 * DataTypes.GEOGRAPHY('POINT')
 * DataTypes.GEOGRAPHY('POINT', 4326)
 */
export class GEOGRAPHY extends GEOMETRY {
  static readonly [kDataTypeIdentifier]: string = 'GEOGRAPHY';

  toSql(): string {
    return 'GEOGRAPHY';
  }
}

/**
 * The cidr type holds an IPv4 or IPv6 network specification. Takes 7 or 19 bytes.
 *
 * Only available for Postgres
 */
export class CIDR extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'CIDR';

  validate(value: any) {
    if (typeof value !== 'string' || !Validator.isIPRange(value)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid CIDR', value),
      );
    }
  }

  toSql(): string {
    return 'CIDR';
  }
}

/**
 * The INET type holds an IPv4 or IPv6 host address, and optionally its subnet. Takes 7 or 19 bytes
 *
 * Only available for Postgres
 */
export class INET extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'INET';
  validate(value: any) {
    if (typeof value !== 'string' || !Validator.isIP(value)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid INET', value),
      );
    }
  }

  toSql(): string {
    return 'INET';
  }
}

/**
 * The MACADDR type stores MAC addresses. Takes 6 bytes
 *
 * Only available for Postgres
 */
export class MACADDR extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'MACADDR';

  validate(value: any) {
    if (typeof value !== 'string' || !Validator.isMACAddress(value)) {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid MACADDR', value),
      );
    }
  }

  toSql(): string {
    return 'MACADDR';
  }
}

/**
 * The TSVECTOR type stores text search vectors.
 *
 * Only available for Postgres
 */
export class TSVECTOR extends AbstractDataType<string> {
  static readonly [kDataTypeIdentifier]: string = 'TSVECTOR';

  validate(value: any) {
    if (typeof value !== 'string') {
      ValidationErrorItem.throwDataTypeValidationError(
        util.format('%O is not a valid string', value),
      );
    }
  }

  protected _checkOptionSupport(dialect: AbstractDialect) {
    if (!dialect.supports.dataTypes.TSVECTOR) {
      throw new Error(`${dialect.name} does not support the TSVECTOR DataType.
See https://sequelize.org/docs/v7/other-topics/other-data-types/#strings for a list of supported String DataTypes.`);
    }
  }

  toSql(): string {
    return 'TSVECTOR';
  }
}

function rejectBlobs(value: unknown) {
  // We have a DataType called BLOB. People might try to use the built-in Blob type with it, which they cannot.
  // To clarify why it doesn't work, we have a dedicated message for it.
  if (Blob && value instanceof Blob) {
    ValidationErrorItem.throwDataTypeValidationError('Blob instances are not supported values, because reading their data is an async operation. Call blob.arrayBuffer() to get a buffer, and pass that to Sequelize instead.');
  }
}

function assertDataTypeSupported(dialect: AbstractDialect, dataType: AbstractDataType<any>) {
  const typeId = dataType.getDataTypeId();

  if (
    typeId in dialect.supports.dataTypes
    // @ts-expect-error
    && !dialect.supports.dataTypes[typeId]
  ) {
    throwUnsupportedDataType(dialect, typeId);
  }
}

function throwUnsupportedDataType(dialect: AbstractDialect, typeName: string): never {
  throw new Error(`${dialect.name} does not support the ${typeName} data type.
See https://sequelize.org/docs/v7/other-topics/other-data-types/ for a list of supported data types.`);
}

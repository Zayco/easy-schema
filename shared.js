import { check as c, Match } from 'meteor/check';
import { MongoID } from 'meteor/mongo-id';
import { pick, isObject, isEmpty, isEqual, capitalize } from './utils';

export const REQUIRED = 'Missing key';
export const Integer = Match.Integer; // Matches only signed 32-bit integers
export const Any = Match.Any;
export const ObjectID = Match.Where(id => id instanceof MongoID.ObjectID);
export const Optional = (type) => Match.Maybe(type);
export const AnyOf = (...args) => Match.OneOf(...args); // Match.OneOf is equivalent to JSON Schema's AnyOf.
export const Where = ({type, ...conditions}) => Match.Where(x => validate({x, type, ...conditions})); // exported for testing only
export const allowed = ['min', 'max', 'regex', 'allow', 'unique', 'where', 'additionalProperties'];
export const isArray = a => Array.isArray(a) && (a !== Integer) && (a !== Any); // Match.Integer is technically modeled as an array so we need to make sure it's not an Integer
export const _shaped = Symbol('_shaped');

export const getValue = v => { // unwraps optional values or just returns the value
  const { constructor: { name } } = v || {};
  const optional = name === 'Maybe';
  const anyOf = name === 'OneOf';

  return {
    optional,
    anyOf,
    value: (optional || anyOf) ? Object.values(v)[0] : v
  }
};

export const hasOperators = obj => Object.keys(obj).some(k => k.includes('$'));

const validate = ({x, type, min, max, regex, allow, unique, where, additionalProperties}) => {
  const errors = [];

  const typeValue = isObject(type) && Object.values(type)[0];
  if (typeValue && typeValue.type) { // handles {type: {thing: String, another: Number}, min: 1, max: 2} // // note: was Object.values(type)[0]?.type but optional chaining increased bundle size
    for (const [k, v] of Object.entries(x)) {
      const { type: embeddedType, ...conditions } = type[k];
      if (embeddedType) { // handles {type: {thing: {type: String, ...}, another: Number}, min: 1, max: 2}
        validate({x: v, type: embeddedType, ...conditions})
      } else {
        const matches = Match.test(v, type[k]);
        if (!matches) {
          errors.push(`Expected ${type[k].name.toLowerCase()}, got ${typeof v} in field ${k}`);
        }
      }
    }
  } else if (type[0] && type[0].type) { // handles shape {type: [{type: String, regex: /com$/, max: 9}], min: 1, max: 2} // note: was type[0]?.type but optional chaining increased bundle size
    const { type: embeddedType, ...conditions } = type[0];
    try {
      c(x, [embeddedType])
    } catch (e) {
      errors.push(e);
    }
    x.forEach(value => {
      validate({x: value, type: embeddedType, ...conditions});
    });
  } else if (isArray(type) && isArray(type[0])) { // handles array of arrays shape [ [] ]
    x.forEach((value, index) => {
      if (value.type) {
        const { type: embeddedType, ...conditions } = value;
        try {
          c(x, embeddedType)
        } catch (e) {
          errors.push(e);
        }
        validate({x: value, type: embeddedType, ...conditions});
      } else {
        try {
          c(value, type[0][index])
        } catch (e) {
          errors.push(e);
        }
      }
    })
  } else if (additionalProperties) { // only for Objects. if additionalProperties: true, then allow additional {key: value} pairs bypass validation by removing them from x
    try {
      c(pick(x, Object.keys(type)), type);
    } catch (e) {
      errors.push(e);
    }
  } else {
    try {
      c(x, type);
    } catch (e) {
      errors.push(e);
    }
  }

  const isAnArray = type => isArray(type) || type === Array;
  const isAnObject = type => isObject(type) || type === Object;

  if (where) {
    try {
      where(x, {min, max, regex, allow, unique});
    } catch(error) {
      errors.push(`w: ${error}`)
    }
  }

  if (min || max) {
    const count = isAnObject(type) ? Object.keys(x).length : (type === String || isAnArray(type)) ? x.length : x;
    const term = isAnObject(type) ? `properties` : type === String ? `characters` : isAnArray(type) ? `items` : '';

    const [mn, mnErr] = Array.isArray(min) ? min : [min];
    const [mx, mxErr] = Array.isArray(max) ? max : [max];
    const minFail = mn && count < mn;

    if (minFail || (mx && count > mx)) {
      errors.push(minFail && mnErr && `w: ${mnErr}` || mxErr && `w: ${mxErr}` || (count < 1 ? `cannot be empty` : `must be ${min ? 'at least ' + min + ' ' + term : ''}${min && mx ? ' and ' : ''}${max ? 'at most ' + mx + ' ' + term : ''}`));
    }
  }

  if (allow) {
    const alwErr = allow.some(Array.isArray) && typeof ([last] = allow.slice(-1))[0] === 'string' ? last : undefined;
    const alw = alwErr ? allow[0] : allow;

    const pass = (isAnObject(type) || isAnArray(type)) ? alw.some(a => isEqual(a, x)) : alw.includes(x) || alw.map(a => a.toString()).includes(x.toString()); // .toString() handles Decimal case
    if (!pass) {
      errors.push(alwErr && `w: ${alwErr}` || `must have an allowed value, not ${JSON.stringify(x)}`);
    }
  }

  if (regex) {
    const [ r, rErr ] = Array.isArray(regex) ? regex : [regex];
    if (!r.test(x)) errors.push(rErr && `w: ${rErr}` || `must match regex ${r}`);
  }

  if (unique) {
    const [ u, uErr ] = Array.isArray(unique) ? unique : [unique];
    if (new Set(x).size !== x.length) errors.push(uErr && `w: ${uErr}` || 'must have unique items')
  }

  if (errors.length) {
    throw new Match.Error(errors.join(' and '))
  }

  return true;
};

export const _getParams = fn => {
  const fnString = fn.toString();
  const match = fnString.match(/let\s*\{\s*([^}]*)\s*\}/);
  if (match) {
    return match[1].split(',').map(m => m.trim().split(':')[0]);
  }

  return Meteor.isClient && Meteor.isDevelopment ? (fnString.match(/\(\s*\{([^}]*)\}\s*\)/)?.[1] || '').split(',').filter(Boolean).map(m => m.trim()) : [...fnString.matchAll(/n\.(\w+)/g)].map(m => m[1]); // vite bundler support
};

// extract pulls out the nested array or object given a path that's an array of keys
const extract = (obj, path) => path.reduce((acc, key, i) => (i === path.length - 1 && key === '0') ? Array.isArray(acc) ? acc : Object.values(acc) : acc[key], obj);

export const enforce = (data, rules) => {
  if (!rules) return;

  const errors = [];
  const keys = Object.keys(data);
  const matchedRules = rules.filter(({ path }) => keys.includes(path[0]));

  for (const { path, rule } of matchedRules) {
    try {
      const ruleData = path.length === 1 ? data : extract(data, path.slice(0, -1));
      if (!((Array.isArray(ruleData) ? ruleData.every(d => rule(d)) : rule(ruleData)) || true)) { // where functions don't have to return true so we set it to true if it doesn't throw from within the where function
        throw 'failed where condition';
      }
    } catch(error) {
      errors.push({ path: path.join('.'), message: `w: ${error}` })
    }
  }

  if (errors.length) {
    throw errors;
  }

  return;
};

export const formatErrors = errors => errors.flatMap(({ path, message: m }) => {
  const type = m.includes('Missing key') ? 'required' : m.includes('Expected') ? 'type' : 'condition';
  const matches = type === 'type' && (m.match(/Expected (.+), got (.+) in/) || m.match(/Expected (.+) in/));
  const errorMessage = type === 'required' ? 'is required' : matches ? `must be a ${matches[1]}${matches[2] ? `, not ${matches[2]}` : ''}` : m.replace(/\b(Match error:|w:|in field\s\S*)/g, '').trim();
  const splitPath = path.split('.');
  const name = type === 'required' ? m.split("'")[1] : splitPath.pop();
  const message = (name && (type !== 'condition' || !m.includes('w:'))) ? `${capitalize(name.replace(/([A-Z])/g, ' $1'))} ${errorMessage}` : capitalize(errorMessage);

  return { name, type, message, ...(splitPath.length > 1 && { path }) };
});

/**
 * Shapes an object based on a POJO.
 *
 * @param {Object} obj - The object to be shaped.
 * @param {Object} [options] - Options object.
 * @param {boolean} [options.optionalize=false] - If true, marks all properties as optional.
 * @returns {Object} The shaped object that's ready to use with jam:easy-schema `check`.
 */
export const shape = (obj, { optionalize = false } = {}) => {
  const rules = []; // rules will stores any dependency rules that are found on embedded objects with 'where' functions that destructure a key that is not the current key

  const sculpt = (obj, currentPath = [], skip = false, isOptional = false) => {
    const maybeOptionalize = value => optionalize && !isOptional ? Optional(value) : value; // using isOptional to prevent double wrapping Optional when it's already been made Optional

    return Object.entries(obj).reduce((acc, [k, v]) => {
      const path = skip ? currentPath : [...currentPath, k]; // we don't want to add Optional or AnyOf keys – 'pattern', '0' – to the path which we use for $rules so we use skip
      const { value, optional, anyOf } = getValue(v);

      if (optional) {
        acc[k] = Optional(...Object.values(sculpt(v, path, true, true)));
      } else if (anyOf) {
        acc[k] = maybeOptionalize(AnyOf(...Object.values(sculpt(value, path, true))));
      } else if (isObject(value) && value.hasOwnProperty('type')) {
        const { type, ...conditions } = value;
        const { where, ...restConditions } = conditions;
        const deps = typeof where === 'function' && where.length === 1 ? _getParams(where).filter(n => n !== k) : [];

        if (Object.keys(conditions).some(i => !allowed.includes(i))) {
          acc[k] = maybeOptionalize(sculpt(value, path));
        } else {
          if (isEmpty(conditions)) {
            acc[k] = maybeOptionalize(type);
          } else {
            const { value: tValue, optional: tOptional } = getValue(type);
            const finalConditions = deps.length ? restConditions : conditions;
            acc[k] = tOptional ? Optional(Where({ type: tValue, ...finalConditions })) : maybeOptionalize(Where({ type, ...finalConditions }));
          }
        }

        if (deps.length) {
          rules.push({
            path,
            rule: where,
            deps
          });
        }
      } else if (isArray(value)) {
        acc[k] = maybeOptionalize(isArray(value[0]) ? [Where({ type: value })] : [...Object.values(sculpt(value, path))]);
      } else if (isObject(value)) {
        acc[k] = maybeOptionalize(sculpt(value, path));
      } else {
        acc[k] = maybeOptionalize(value);
      }
      return acc;
    }, {});
  };

  const result = sculpt(obj);
  rules.length && (result.$rules = rules);
  Object.defineProperty(result, _shaped, {value: true});
  return result;
};

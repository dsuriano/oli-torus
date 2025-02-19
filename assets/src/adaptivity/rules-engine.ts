import { Environment } from 'janus-script';
import {
  AllConditions,
  AnyConditions,
  ConditionProperties,
  Engine,
  EngineResult,
  Event,
  NestedCondition,
  RuleProperties,
  TopLevelCondition,
} from 'json-rules-engine';
import { parseArray } from 'utils/common';
import { b64EncodeUnicode } from 'utils/decode';
import { CapiVariableTypes, JanusConditionProperties } from './capi';
import { janus_std } from './janus-scripts/builtin_functions';
import containsOperators from './operators/contains';
import equalityOperators from './operators/equality';
import mathOperators from './operators/math';
import rangeOperators from './operators/range';
import {
  bulkApplyState,
  evalAssignScript,
  evalScript,
  extractAllExpressionsFromText,
  extractUniqueVariablesFromText,
  getExpressionStringForValue,
  getValue,
} from './scripting';

export interface JanusRuleProperties extends RuleProperties {
  id?: string;
  disabled: boolean;
  default: boolean;
  correct: boolean;
  additionalScore?: number;
  forceProgress?: boolean;
}

const engineOperators: any = {
  ...containsOperators,
  ...rangeOperators,
  ...equalityOperators,
  ...mathOperators,
};

const rulesEngineFactory = () => {
  const engine = new Engine([], { allowUndefinedFacts: true });

  Object.keys(engineOperators).forEach((opName) => {
    engine.addOperator(opName, engineOperators[opName]);
  });

  return engine;
};

const applyToEveryCondition = (top: TopLevelCondition | NestedCondition, callback: any): void => {
  const conditions = (top as AllConditions).all || (top as AnyConditions).any;
  conditions.forEach((condition) => {
    if ((condition as AllConditions).all || (condition as AnyConditions).any) {
      // nested
      applyToEveryCondition(condition, callback);
    } else {
      callback(condition as ConditionProperties);
    }
  });
};

const evaluateValueExpression = (value: string, env: Environment) => {
  if (typeof value !== 'string') {
    return value;
  }
  const expr = getExpressionStringForValue({ type: CapiVariableTypes.STRING, value }, env);
  let { result } = evalScript(expr, env);
  if (result === value) {
    try {
      const evaluatedValue = evalScript(value, env);
      const canEval = evaluatedValue?.result !== undefined && !evaluatedValue.result.message;
      if (canEval) {
        result = evaluatedValue.result;
      }
    } catch (ex) {
      // if it's and expression and it wasn't evaluated till this point then it means the equation is something like
      //{17/1.5*{q:1500660404583:613|stage.DrinkVolume.value}*{q:1500660389923:565|variables.UnknownBeaker}*176.12} and script engine can't evaluate the expression if it
      // starts with {} and the brackets does not begin with an actual variable. we need to send it as '17/1.5*{q:1500660404583:613|stage.DrinkVolume.value}*{q:1500660389923:565|variables.UnknownBeaker}*176.12'
      const expressions = extractAllExpressionsFromText(value);
      //adding more safety so that it does not break anything else.
      // A expression will not have a ';' inside it. So if there is a ';' inside it, it is CSS. Ignore that
      const updatedVariables = expressions.filter((e) => !e.includes(';'));
      const updatedValue = typeof value === 'string' ? value.trim() : value;
      if (
        typeof updatedValue === 'string' &&
        updatedVariables?.length &&
        updatedValue[0] === '{' &&
        updatedValue[updatedValue.length - 1] === '}'
      ) {
        try {
          const evaluatedValue = evalScript(
            updatedValue.substring(1, updatedValue.length - 1),
            env,
          );

          const canEval = evaluatedValue?.result !== undefined && !evaluatedValue.result.message;
          if (canEval) {
            result = evaluatedValue.result;
          }
        } catch (ex) {
          return result;
        }
      }
      return result;
    }
  }
  return result;
};

const processRules = (rules: JanusRuleProperties[], env: Environment) => {
  rules.forEach((rule, index) => {
    // tweak priority to match order
    rule.priority = index + 1;
    // note: maybe authoring / conversion should just write these here so we
    // dont have to do it at runtime
    rule.event.params = {
      ...rule.event.params,
      order: rule.priority,
      correct: !!rule.correct,
      default: !!rule.default,
    };
    //need the 'type' property hence using JanusConditionProperties which extends ConditionProperties
    applyToEveryCondition(rule.conditions, (condition: JanusConditionProperties) => {
      const ogValue = condition.value;
      let modifiedValue = ogValue;
      if (Array.isArray(ogValue)) {
        modifiedValue = ogValue.map((value) =>
          typeof value === 'string' ? evaluateValueExpression(value, env) : value,
        );
      }
      if (
        condition?.operator === 'equalWithTolerance' ||
        condition?.operator === 'notEqualWithTolerance'
      ) {
        //Usually the tolerance is 5.28,2 where 5.28 is actual value and 2 is the tolerance so we need to separate the value and send it in evaluateValueExpression()
        //Also in case the tolerance is not specified and the value is 5.28 only, we need handle it so that it evaluates the actual value otherwise
        // it will evaluated as ""
        let actualValue = ogValue;
        let toleranceValue = 0;
        if (typeof ogValue === 'object') {
          if (ogValue.length === 2) {
            actualValue = ogValue[0];
            toleranceValue = ogValue[1];
          } else {
            actualValue = ogValue;
          }
        } else if (ogValue.lastIndexOf(',') !== -1) {
          toleranceValue = ogValue.substring(ogValue.lastIndexOf(',') + 1);
          actualValue = ogValue.substring(0, ogValue.lastIndexOf(','));
        } else {
          actualValue = ogValue;
        }
        const evaluatedValue = evaluateValueExpression(actualValue, env);
        modifiedValue = `${evaluatedValue},${toleranceValue}`;
      } else if (condition?.operator === 'inRange' || condition?.operator === 'notInRange') {
        // these have min, max, and optionally (unused) tolerance
        if (Array.isArray(ogValue)) {
          modifiedValue = ogValue
            .map((value) =>
              typeof value === 'string' ? evaluateValueExpression(value, env) : value,
            )
            .join(',');
        } else if (typeof ogValue === 'string') {
          modifiedValue = parseArray(ogValue)
            .map((value) =>
              typeof value === 'string' ? evaluateValueExpression(value, env) : value,
            )
            .join(',');
        }
      } else if (typeof ogValue === 'string' && ogValue.indexOf('{') === -1) {
        modifiedValue = ogValue;
      } else {
        const evaluatedValue = evaluateValueExpression(ogValue, env);
        if (typeof evaluatedValue === 'string') {
          //if the converted value is string then we don't have to stringify (e.g. if the evaluatedValue = L and we stringyfy it then the value becomes '"L"' instead if 'L'
          // hence a trap state checking 'L' === 'L' returns false as the expression becomes 'L' === '"L"')
          modifiedValue = evaluatedValue;
        } else if (typeof modifiedValue === 'number') {
          return modifiedValue;
        } else if (typeof ogValue === 'string') {
          //Need to stringify only if it was converted into object during evaluation process and we expect it to be string
          modifiedValue = JSON.stringify(evaluateValueExpression(ogValue, env));
        }
      }
      //if it type ===3 then it is a array. We need to wrap it in [] if it is not already wrapped.
      if (
        typeof ogValue === 'string' &&
        condition?.type === CapiVariableTypes.ARRAY &&
        ogValue.charAt(0) !== '[' &&
        ogValue.slice(-1) !== ']'
      ) {
        modifiedValue = `[${ogValue}]`;
      }

      if (
        condition?.type === CapiVariableTypes.ARRAY &&
        (condition?.operator === 'containsAnyOf' || condition?.operator === 'notContainsAnyOf')
      ) {
        const targetValue = getValue(condition.fact, env);
        if (
          typeof targetValue === 'string' &&
          targetValue.charAt(0) !== '[' &&
          targetValue.slice(-1) !== ']'
        ) {
          const modifiedTargetValue = `[${targetValue}]`;
          const updateAttempt = [
            {
              target: `${condition.fact}`,
              operator: '=',
              value: modifiedTargetValue,
            },
          ];
          bulkApplyState(updateAttempt, env);
        }
      }
      condition.value = modifiedValue;
    });
  });
};

export const defaultWrongRule = {
  id: 'builtin.defaultWrong',
  name: 'defaultWrong',
  priority: 1,
  disabled: false,
  additionalScore: 0,
  forceProgress: false,
  default: true,
  correct: false,
  conditions: { all: [] },
  event: {
    type: 'builtin.defaultWrong',
    params: {
      actions: [
        {
          type: 'feedback',
          params: {
            feedback: {
              id: 'builtin.feedback',
              custom: {
                showCheckBtn: true,
                panelHeaderColor: 10027008,
                rules: [],
                facts: [],
                applyBtnFlag: false,
                checkButtonLabel: 'Next',
                applyBtnLabel: 'Show Solution',
                mainBtnLabel: 'Next',
                panelTitleColor: 16777215,
                lockCanvasSize: true,
                width: 350,
                palette: {
                  fillColor: 16777215,
                  fillAlpha: 1,
                  lineColor: 16777215,
                  lineAlpha: 1,
                  lineThickness: 0.1,
                  lineStyle: 0,
                  useHtmlProps: false,
                  backgroundColor: 'rgba(255,255,255,0)',
                  borderColor: 'rgba(255,255,255,0)',
                  borderWidth: '1px',
                  borderStyle: 'solid',
                },
                height: 100,
              },
              partsLayout: [
                {
                  id: 'builtin.feedback.textflow',
                  type: 'janus-text-flow',
                  custom: {
                    overrideWidth: true,
                    nodes: [
                      {
                        tag: 'p',
                        style: { fontSize: '16' },
                        children: [
                          {
                            tag: 'span',
                            style: { fontWeight: 'bold' },
                            children: [
                              {
                                tag: 'text',
                                text: 'Incorrect, please try again.',
                                children: [],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                    x: 10,
                    width: 330,
                    overrideHeight: false,
                    y: 10,
                    z: 0,
                    palette: {
                      fillColor: 16777215,
                      fillAlpha: 1,
                      lineColor: 16777215,
                      lineAlpha: 0,
                      lineThickness: 0.1,
                      lineStyle: 0,
                      useHtmlProps: false,
                      backgroundColor: 'rgba(255,255,255,0)',
                      borderColor: 'rgba(255,255,255,0)',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                    },
                    customCssClass: '',
                    height: 22,
                  },
                },
              ],
            },
          },
        },
      ],
    },
  },
};

export const findReferencedActivitiesInConditions = (conditions: any) => {
  const referencedKeys = getReferencedKeysInConditions(conditions);
  const sequenceRefs = referencedKeys
    .filter((key) => key.indexOf('|stage.') !== -1)
    .map((key) => key.split('|')[0]);

  /* console.log('findReferencedActivitiesInConditions', { referencedKeys, sequenceRefs }); */

  return Array.from(new Set(sequenceRefs));
};

export const getReferencedKeysInConditions = (conditions: any) => {
  const references: Set<string> = new Set();

  conditions.forEach(
    (condition: {
      all: boolean;
      any: boolean;
      fact: string;
      value: string | number | boolean | unknown;
    }) => {
      // the fact *must* be a reference to a key we need
      if (condition.fact) {
        references.add(condition.fact);
      }
      // the value *might* contain a reference to a key we need
      if (typeof condition.value === 'string') {
        extractUniqueVariablesFromText(condition.value).forEach((v) => references.add(v));
      } else if (Array.isArray(condition.value)) {
        condition.value.forEach((value: any) => {
          if (typeof value === 'string') {
            extractUniqueVariablesFromText(value).forEach((v) => references.add(v));
          }
        });
      }
      if (condition.any || condition.all) {
        const childRefs = getReferencedKeysInConditions(condition.any || condition.all);
        childRefs.forEach((ref) => references.add(ref));
      }
    },
  );

  return Array.from(references);
};

export const findReferencedActivitiesInActions = (actions: any) => {
  const referencedKeys = getReferencedKeysInActions(actions);
  const sequenceRefs = referencedKeys
    .filter((key) => key.indexOf('|stage.') !== -1)
    .map((key) => key.split('|')[0]);

  /* console.log('findReferencedActivitiesInActions', { referencedKeys, sequenceRefs }); */

  return Array.from(new Set(sequenceRefs));
};

export const getReferencedKeysInActions = (actions: any) => {
  const references: Set<string> = new Set();
  actions.forEach(
    (action: {
      params: { target: string; value: string | number | boolean | unknown };
      type: string;
    }) => {
      if (action.type === 'mutateState') {
        // the target *must* be a reference to a key we need
        if (action.params.target) {
          references.add(action.params.target);
        }

        // the value *might* contain a reference to a key we need
        if (typeof action.params.value === 'string') {
          extractUniqueVariablesFromText(action.params.value).forEach((v) => references.add(v));
        } else if (Array.isArray(action.params.value)) {
          action.params.value.forEach((value: any) => {
            if (typeof value === 'string') {
              extractUniqueVariablesFromText(value).forEach((v) => references.add(v));
            }
          });
        }
      }
    },
  );
  return Array.from(references);
};

export interface CheckResult {
  correct: boolean;
  results: Event[];
  score: number;
  out_of: number;
  debug?: any;
}

export interface ScoringContext {
  maxScore: number;
  maxAttempt: number;
  trapStateScoreScheme: boolean;
  negativeScoreAllowed: boolean;
  currentAttemptNumber: number;
  isManuallyGraded: boolean;
}

export const check = async (
  state: Record<string, unknown>,
  rules: JanusRuleProperties[],
  scoringContext: ScoringContext,
  encodeResults = false,
): Promise<CheckResult | string> => {
  // load the std lib
  const { env } = evalScript(janus_std);

  const { result: assignResults } = evalAssignScript(state, env);
  // console.log('RULES ENGINE STATE ASSIGN', { assignResults, state, env });

  // evaluate all rule conditions against context
  const enabledRules = rules.filter((r) => !r.disabled);
  if (enabledRules.length === 0 || !enabledRules.find((r) => r.default && !r.correct)) {
    enabledRules.push(defaultWrongRule);
  }
  processRules(enabledRules, env);

  // finally run check
  const engine: Engine = rulesEngineFactory();
  const facts: Record<string, unknown> = env.toObj();

  enabledRules.forEach((rule) => {
    // $log.info('RULE: ', JSON.stringify(rule, null, 4));
    engine.addRule(rule);
  });

  const checkResult: EngineResult = await engine.run(facts);

  /* console.log('RE CHECK', { checkResult }); */
  let resultEvents: Event[] = [];
  const successEvents = checkResult.events.sort((a, b) => a.params?.order - b.params?.order);

  // if every event is correct excluding the default wrong, then we are definitely correct
  let defaultWrong = successEvents.find((e) => e.params?.default && !e.params?.correct);
  if (!defaultWrong) {
    console.warn('no default wrong found, there should always be one!');
    // we should never actually get here, because the rules should be implanted earlier,
    // however, in case we still do, use this because it's better than nothing
    defaultWrong = defaultWrongRule.event;
  }
  resultEvents = successEvents.filter((evt) => evt !== defaultWrong);
  // if anything is correct, then we are correct
  const isCorrect = !!resultEvents.length && resultEvents.some((evt) => evt.params?.correct);
  // if we are not correct, then lets filter out any correct
  if (!isCorrect) {
    resultEvents = resultEvents.filter((evt) => !evt.params?.correct);
  } else {
    // if we are correct, then lets filter out any incorrect
    resultEvents = resultEvents.filter((evt) => evt.params?.correct);
  }

  // if we don't have any events left, then it's the default wrong
  if (!resultEvents.length) {
    resultEvents = [defaultWrong as Event];
  }

  let score = 0;
  if (scoringContext.trapStateScoreScheme) {
    // apply all the actions from the resultEvents that mutate the state
    // then check the session.currentQuestionScore and clamp it against the maxScore
    // setting that value to score
    const mutations = resultEvents.reduce((acc, evt) => {
      const { actions } = evt.params as Record<string, any>;
      const mActions = actions.filter(
        (action: any) =>
          action.type === 'mutateState' && action.params.target === 'session.currentQuestionScore',
      );
      return acc.concat(...acc, mActions);
    }, []);
    if (mutations.length) {
      const mutApplies = mutations.map(({ params }) => params);

      bulkApplyState(mutApplies, env);
      score = getValue('session.currentQuestionScore', env) || 0;
    }
  }
  //below condition make sure the score calculation will happen only if the answer is correct and
  //in case of incorrect answer if negative scoring is allowed then calculation will proceed.
  else if (isCorrect || scoringContext.negativeScoreAllowed) {
    const { maxScore, maxAttempt, currentAttemptNumber } = scoringContext;
    const scorePerAttempt = maxScore / maxAttempt;
    score = maxScore - scorePerAttempt * (currentAttemptNumber - 1);
  }
  score = Math.min(score, scoringContext.maxScore || 0);
  if (!scoringContext.negativeScoreAllowed) {
    score = Math.max(0, score);
  }

  // if this activity has manual grading, then the score should just be zero so that it can be graded manually
  if (scoringContext.isManuallyGraded) {
    score = 0;
  }
  // make sure that score is *always* a number
  score = isNaN(Number(score)) ? 0 : Number(score);

  const finalResults = {
    correct: isCorrect,
    score,
    out_of: scoringContext.maxScore || 0,
    results: resultEvents,
    debug: {
      sent: resultEvents.map((e) => e.type),
      all: successEvents.map((e) => e.type),
    },
  };
  if (encodeResults) {
    return b64EncodeUnicode(JSON.stringify(finalResults));
  } else {
    return finalResults;
  }
};

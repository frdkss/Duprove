import type { SurveyAnswer, SurveyQuestion } from '../types/survey'

export default function isSurveyAnswerValid(question: SurveyQuestion, answer?: SurveyAnswer) {
  if (!answer) return false
  if (answer.kind === 'custom') return answer.text.trim().length > 0
  return question.options.some((option) => option.id === answer.optionId)
}

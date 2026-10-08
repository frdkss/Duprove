import { useState } from 'react'
import isSurveyAnswerValid from '../lib/isSurveyAnswerValid'
import type { SurveyAnswer, SurveyAnswers, SurveyQuestion } from '../types/survey'

export default function useSurvey(questions: SurveyQuestion[]) {
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<SurveyAnswers>({})
  const [completed, setCompleted] = useState(false)
  const question = questions[questionIndex]
  const answer = question ? answers[question.id] : undefined
  const canContinue = Boolean(question && isSurveyAnswerValid(question, answer))
  const lastQuestion = questionIndex === questions.length - 1

  const updateAnswer = (nextAnswer: SurveyAnswer) => {
    if (question) setAnswers((current) => ({ ...current, [question.id]: nextAnswer }))
  }

  const next = () => {
    if (!canContinue) return
    if (lastQuestion) setCompleted(true)
    else setQuestionIndex((current) => current + 1)
  }

  const previous = () => {
    setCompleted(false)
    setQuestionIndex((current) => Math.max(0, current - 1))
  }

  const restart = () => {
    setAnswers({})
    setQuestionIndex(0)
    setCompleted(false)
  }

  return {
    question,
    answer,
    questionIndex,
    canContinue,
    lastQuestion,
    completed,
    updateAnswer,
    next,
    previous,
    restart,
  }
}

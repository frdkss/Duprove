import { useEffect, useRef } from 'react'
import { surveyQuestions } from '../../config/survey'
import useSurvey from '../../hooks/useSurvey'
import SurveyQuestion from '../SurveyQuestion/SurveyQuestion'
import './Survey.css'

export default function Survey() {
  const survey = useSurvey(surveyQuestions)
  const stepRef = useRef<HTMLDivElement>(null)
  const previousStep = useRef('0-false')

  useEffect(() => {
    const step = `${survey.questionIndex}-${survey.completed}`
    if (step !== previousStep.current) stepRef.current?.focus()
    previousStep.current = step
  }, [survey.questionIndex, survey.completed])

  return (
    <section className="survey" aria-labelledby="survey-title">
      <h3 id="survey-title" className="survey__title">
        Анонимный опрос
      </h3>
      {surveyQuestions.length === 0 ? (
        <div className="survey__empty">
          <p>Вопросы появятся позже.</p>
        </div>
      ) : (
        <div ref={stepRef} className="survey__step" tabIndex={-1}>
          {survey.completed ? (
            <div className="survey__completed">
              <p>Вы ответили на все вопросы.</p>
              <p className="survey__notice">
                Отправка пока не подключена. Ответы никуда не переданы.
              </p>
              <button className="survey__button" type="button" onClick={survey.restart}>
                Начать заново
              </button>
            </div>
          ) : (
            survey.question && (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  survey.next()
                }}
              >
                <p className="survey__progress">
                  Вопрос {survey.questionIndex + 1} из {surveyQuestions.length}
                </p>
                <SurveyQuestion
                  question={survey.question}
                  answer={survey.answer}
                  onChange={survey.updateAnswer}
                />
                <div className="survey__actions">
                  {survey.questionIndex > 0 && (
                    <button type="button" className="survey__back" onClick={survey.previous}>
                      Назад
                    </button>
                  )}
                  <button type="submit" className="survey__button" disabled={!survey.canContinue}>
                    {survey.lastQuestion ? 'Завершить' : 'Далее'}
                  </button>
                </div>
                <p className="survey__notice">Отправка ответов пока не подключена.</p>
              </form>
            )
          )}
        </div>
      )}
    </section>
  )
}

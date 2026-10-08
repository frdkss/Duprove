import type { SurveyAnswer, SurveyQuestion as Question } from '../../types/survey'
import './SurveyQuestion.css'

interface SurveyQuestionProps {
  question: Question
  answer?: SurveyAnswer
  onChange: (answer: SurveyAnswer) => void
}

export default function SurveyQuestion({ question, answer, onChange }: SurveyQuestionProps) {
  return (
    <fieldset className="survey-question">
      <legend className="survey-question__title">{question.title}</legend>
      <div className="survey-question__answers">
        <div className="survey-question__options">
          {question.options.map((option) => (
            <label key={option.id} className="survey-question__option">
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={answer?.kind === 'option' && answer.optionId === option.id}
                onChange={() => onChange({ kind: 'option', optionId: option.id })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <label className="survey-question__custom">
          <span>Свой ответ:</span>
          <textarea
            aria-label="Свой ответ"
            name={`${question.id}-custom`}
            maxLength={2000}
            value={answer?.kind === 'custom' ? answer.text : ''}
            onChange={(event) => onChange({ kind: 'custom', text: event.target.value })}
          />
        </label>
      </div>
    </fieldset>
  )
}

# Независимый Python backend

Этап 7: HTTP API, проверка статистики, ограниченное хранилище SQLite и очистка
по сроку хранения. Отдельный проект Docker Compose включает HTTPS-прокси и
ограничения ресурсов. По решению пользователя от 2026-10-15 этап завершён
в объёме локального Docker; публичное размещение отложено. Возможная будущая
площадка — `download.licetvideo.ru`, адрес приёмника и доступ ещё не определены.
Для отладки: `npm run server:dev` из корня проекта;
актуальный IP контейнера и локальный HTTPS URL сохраняются в `.env`.

API, выбранные лимиты, приватность, установка, остановка и удаление:
[docs/statistics-server.md](../docs/statistics-server.md).

Проверки: `npm run test:backend`, `npm run test:server`,
`npm run test:server:deployment` (Docker Compose и openssl, только искусственные данные).

CLI этапа 1 сохранён отдельно от сервера:
Принимает один JSON из stdin, выводит только `{"accepted": true|false}`;
код выхода 0 при корректном отчёте, 1 при некорректном. Не выводит входные данные,
пути, диагностические значения валидатора или IP-адреса.

Установка из корня репозитория:

```sh
python -m pip install -r backend/requirements.txt
```

Запуск в каталоге `backend`:

```sh
python -m duprove_backend < ../contracts/fixtures/example.json
```

PowerShell, из корня:

```powershell
Get-Content contracts/fixtures/example.json -Raw | .venv/Scripts/python.exe -m backend.duprove_backend
```

Для отдельного размещения нужны только `backend/` и `contracts/report.schema.json`
с сохранением взаимного расположения. C++, Electron и Node не нужны.
Python-библиотеки сервера — `requirements-server.txt`; Gunicorn запускается на Linux.
В этапе 8 добавлена атомарная защита от повторного учёта через `Idempotency-Key`;
JSON v1 не изменён. Клиентская очередь и HTTPS-транспорт:
[docs/report-delivery.md](../docs/report-delivery.md).

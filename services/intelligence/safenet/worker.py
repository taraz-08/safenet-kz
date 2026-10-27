from celery import Celery
from .settings import settings

celery = Celery("safenet", broker=settings.redis_url, backend=settings.redis_url)
celery.conf.update(task_serializer="json", accept_content=["json"], result_serializer="json", timezone="UTC", worker_prefetch_multiplier=1, task_acks_late=True, task_reject_on_worker_lost=True, task_time_limit=660, task_soft_time_limit=630, result_expires=3600, broker_connection_retry_on_startup=True, beat_schedule={"schedule-monitors": {"task": "safenet.schedule", "schedule": 10}, "retention": {"task": "safenet.cleanup", "schedule": 3600}})


@celery.task(name="safenet.scan")
def execute_scan(task_id):
    from .runner import execute
    execute(task_id)


@celery.task(name="safenet.schedule")
def schedule_agents():
    from .runner import schedule
    schedule()


@celery.task(name="safenet.cleanup")
def cleanup_history():
    from .runner import cleanup
    cleanup()

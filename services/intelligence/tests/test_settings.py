from sqlalchemy.engine import make_url
from safenet.settings import Settings


def test_structured_postgres_configuration_encodes_password_delimiters():
    password = "test@host:/?#%value"
    config = Settings(database_host="postgres", database_user="operator", database_password=password, database_name="safenet")
    url = make_url(config.database_url)
    assert url.host == "postgres"
    assert url.username == "operator"
    assert url.password == password
    assert url.database == "safenet"


def test_explicit_local_url_without_host_stays_local():
    config = Settings(database_host="", database_url="sqlite:///./runtime/test.db")
    assert config.database_url == "sqlite:///./runtime/test.db"

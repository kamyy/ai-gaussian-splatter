import httpx
import respx

from pipeline import instance

IMDS = "http://169.254.169.254/latest"


@respx.mock
def test_get_self_instance_id_reads_the_id_with_an_imdsv2_token():
    respx.put(f"{IMDS}/api/token").mock(return_value=httpx.Response(200, text="imds-token"))
    id_route = respx.get(f"{IMDS}/meta-data/instance-id").mock(return_value=httpx.Response(200, text="i-0abc123"))

    assert instance.get_self_instance_id() == "i-0abc123"
    assert id_route.calls.last.request.headers["X-aws-ec2-metadata-token"] == "imds-token"


@respx.mock
def test_get_self_instance_id_is_none_off_ec2():
    respx.put(f"{IMDS}/api/token").mock(side_effect=httpx.ConnectTimeout("no route"))

    assert instance.get_self_instance_id() is None


@respx.mock
def test_get_self_instance_id_is_none_when_imds_refuses_the_token():
    # What a hop limit of 1 looks like from inside the container: no usable token, so no instance id.
    respx.put(f"{IMDS}/api/token").mock(return_value=httpx.Response(401))

    assert instance.get_self_instance_id() is None


def test_terminate_self_terminates_its_own_instance(mocker):
    mocker.patch.object(instance, "get_self_instance_id", return_value="i-0abc123")
    client = mocker.patch.object(instance.boto3, "client")

    instance.terminate_self()

    client.assert_called_once_with("ec2")
    client.return_value.terminate_instances.assert_called_once_with(InstanceIds=["i-0abc123"])


def test_terminate_self_does_nothing_off_ec2(mocker):
    mocker.patch.object(instance, "get_self_instance_id", return_value=None)
    client = mocker.patch.object(instance.boto3, "client")

    instance.terminate_self()

    client.assert_not_called()


def test_terminate_self_logs_rather_than_raises_when_terminate_fails(mocker):
    # It runs in worker/run_job.py's finally block, where raising would replace the job's own result.
    mocker.patch.object(instance, "get_self_instance_id", return_value="i-0abc123")
    client = mocker.patch.object(instance.boto3, "client")
    client.return_value.terminate_instances.side_effect = RuntimeError("UnauthorizedOperation")

    instance.terminate_self()

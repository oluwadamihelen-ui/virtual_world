// NOT COMPILED YET: written without an Unreal Engine installation. See unreal/README.md.
#include "MVWBackendSubsystem.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "HAL/PlatformMisc.h"
#include "HAL/IConsoleManager.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"

DEFINE_LOG_CATEGORY_STATIC(LogMVWBackend, Log, All);

void UMVWBackendSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	if (!IsRunningDedicatedServer() && !GIsEditor)
	{
		return; // packaged clients must never be able to call the economy API
	}
	BaseUrl = TEXT("http://127.0.0.1:3000");
	FParse::Value(FCommandLine::Get(), TEXT("MvwBackendUrl="), BaseUrl);
	ServerKey = FPlatformMisc::GetEnvironmentVariable(TEXT("MVW_SERVER_KEY"));
	if (ServerKey.IsEmpty())
	{
		UE_LOG(LogMVWBackend, Error, TEXT("MVW_SERVER_KEY is not set; backend calls will be rejected"));
	}
	UE_LOG(LogMVWBackend, Log, TEXT("Backend: %s"), *BaseUrl);
}

void UMVWBackendSubsystem::Send(const FString& Verb, const FString& Path, TSharedPtr<FJsonObject> Body, FMVWBackendCallback Callback)
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
	Req->SetURL(BaseUrl + Path);
	Req->SetVerb(Verb);
	Req->SetHeader(TEXT("x-server-key"), ServerKey);
	Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Req->SetTimeout(10.f);
	if (Body.IsValid())
	{
		FString Out;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
		FJsonSerializer::Serialize(Body.ToSharedRef(), Writer);
		Req->SetContentAsString(Out);
	}
	Req->OnProcessRequestComplete().BindLambda([Callback](FHttpRequestPtr, FHttpResponsePtr Resp, bool bOk)
	{
		FMVWBackendResult Result;
		if (bOk && Resp.IsValid())
		{
			Result.Status = Resp->GetResponseCode();
			TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Resp->GetContentAsString());
			FJsonSerializer::Deserialize(Reader, Result.Json);
		}
		Callback.ExecuteIfBound(Result);
	});
	Req->ProcessRequest();
}

static TSharedPtr<FJsonObject> MakeBody() { return MakeShared<FJsonObject>(); }

void UMVWBackendSubsystem::CheckHealth(FMVWBackendCallback Callback)
{
	Send(TEXT("GET"), TEXT("/healthz"), nullptr, Callback);
}

void UMVWBackendSubsystem::FetchShop(const FString& ShopId, FMVWBackendCallback Callback)
{
	Send(TEXT("GET"), FString::Printf(TEXT("/v1/game/world/shops/%s"), *ShopId), nullptr, Callback);
}

void UMVWBackendSubsystem::RedeemJoinTicket(const FString& Ticket, FMVWBackendCallback Callback)
{
	TSharedPtr<FJsonObject> B = MakeBody();
	B->SetStringField(TEXT("ticket"), Ticket);
	Send(TEXT("POST"), TEXT("/v1/game/tickets/redeem"), B, Callback);
}

void UMVWBackendSubsystem::BusinessPurchase(const FString& CharacterId, const FString& BusinessId, const FString& ItemId, int32 Quantity,
	const FString& IdempotencyKey, FMVWBackendCallback Callback)
{
	TSharedPtr<FJsonObject> B = MakeBody();
	B->SetStringField(TEXT("itemId"), ItemId);
	B->SetNumberField(TEXT("quantity"), Quantity);
	B->SetStringField(TEXT("idempotencyKey"), IdempotencyKey);
	Send(TEXT("POST"), FString::Printf(TEXT("/v1/game/characters/%s/business-purchase/%s"), *CharacterId, *BusinessId), B, Callback);
}

void UMVWBackendSubsystem::CheckChat(const FString& CharacterId, const FString& Text, FMVWBackendCallback Callback)
{
	TSharedPtr<FJsonObject> B = MakeBody();
	B->SetStringField(TEXT("characterId"), CharacterId);
	B->SetStringField(TEXT("text"), Text);
	Send(TEXT("POST"), TEXT("/v1/game/chat/check"), B, Callback);
}

void UMVWBackendSubsystem::IsBlocked(const FString& CharacterA, const FString& CharacterB, FMVWBackendCallback Callback)
{
	Send(TEXT("GET"), FString::Printf(TEXT("/v1/game/social/blocked/%s/%s"), *CharacterA, *CharacterB), nullptr, Callback);
}

void UMVWBackendSubsystem::JoinCharacter(const FString& CharacterId, FMVWBackendCallback Callback)
{
	Send(TEXT("POST"), FString::Printf(TEXT("/v1/game/characters/%s/join"), *CharacterId), MakeBody(), Callback);
}

void UMVWBackendSubsystem::Purchase(const FString& CharacterId, const FString& ShopId, const FString& ItemId, int32 Quantity,
	const FString& IdempotencyKey, FMVWBackendCallback Callback)
{
	TSharedPtr<FJsonObject> B = MakeBody();
	B->SetStringField(TEXT("itemId"), ItemId);
	B->SetNumberField(TEXT("quantity"), Quantity);
	B->SetStringField(TEXT("idempotencyKey"), IdempotencyKey);
	Send(TEXT("POST"), FString::Printf(TEXT("/v1/game/characters/%s/shops/%s/purchase"), *CharacterId, *ShopId), B, Callback);
}

void UMVWBackendSubsystem::RentProperty(const FString& CharacterId, const FString& PropertyId, const FString& IdempotencyKey, FMVWBackendCallback Callback)
{
	TSharedPtr<FJsonObject> B = MakeBody();
	B->SetStringField(TEXT("propertyId"), PropertyId);
	B->SetStringField(TEXT("idempotencyKey"), IdempotencyKey);
	Send(TEXT("POST"), FString::Printf(TEXT("/v1/game/characters/%s/rent"), *CharacterId), B, Callback);
}

void UMVWBackendSubsystem::StartShift(const FString& CharacterId, const FString& JobId, FMVWBackendCallback Callback)
{
	TSharedPtr<FJsonObject> B = MakeBody();
	B->SetStringField(TEXT("jobId"), JobId);
	Send(TEXT("POST"), FString::Printf(TEXT("/v1/game/characters/%s/shifts"), *CharacterId), B, Callback);
}

void UMVWBackendSubsystem::CompleteShiftTask(const FString& CharacterId, const FString& ShiftId, FMVWBackendCallback Callback)
{
	Send(TEXT("POST"), FString::Printf(TEXT("/v1/game/characters/%s/shifts/%s/task"), *CharacterId, *ShiftId), MakeBody(), Callback);
}

void UMVWBackendSubsystem::CompleteShift(const FString& CharacterId, const FString& ShiftId, FMVWBackendCallback Callback)
{
	Send(TEXT("POST"), FString::Printf(TEXT("/v1/game/characters/%s/shifts/%s/complete"), *CharacterId, *ShiftId), MakeBody(), Callback);
}

void UMVWBackendSubsystem::SavePosition(const FString& CharacterId, const FString& District, const FVector& Location)
{
	TSharedPtr<FJsonObject> B = MakeBody();
	B->SetStringField(TEXT("district"), District);
	B->SetNumberField(TEXT("x"), Location.X);
	B->SetNumberField(TEXT("y"), Location.Y);
	B->SetNumberField(TEXT("z"), Location.Z);
	Send(TEXT("PUT"), FString::Printf(TEXT("/v1/game/characters/%s/position"), *CharacterId), B, FMVWBackendCallback());
}

// ---------------------------------------------------------------------------------------------
// In-editor smoke tests. Open the console with the ` (tilde) key while playing and type:
//   mvw.health   -> shows whether the backend answers
//   mvw.shop     -> shows the Corner Grocery stock (proves the server key works)
// ---------------------------------------------------------------------------------------------
static void MvwShow(const FString& Msg, const FColor& Color)
{
	UE_LOG(LogMVWBackend, Log, TEXT("%s"), *Msg);
	if (GEngine)
	{
		GEngine->AddOnScreenDebugMessage(-1, 10.f, Color, Msg);
	}
}

static UMVWBackendSubsystem* MvwGetSubsystem(UWorld* World)
{
	UGameInstance* GI = World ? World->GetGameInstance() : nullptr;
	return GI ? GI->GetSubsystem<UMVWBackendSubsystem>() : nullptr;
}

static FAutoConsoleCommandWithWorldAndArgs GMvwHealthCmd(
	TEXT("mvw.health"), TEXT("Check that the MVW backend is reachable"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>&, UWorld* World)
	{
		UMVWBackendSubsystem* Sub = MvwGetSubsystem(World);
		if (!Sub) { MvwShow(TEXT("MVW: backend subsystem not available (it only runs in the editor or on a dedicated server)"), FColor::Red); return; }
		Sub->CheckHealth(FMVWBackendCallback::CreateLambda([](const FMVWBackendResult& R)
		{
			if (R.Ok()) { MvwShow(TEXT("MVW backend: ONLINE"), FColor::Green); }
			else { MvwShow(FString::Printf(TEXT("MVW backend: NOT REACHABLE (status %d). Is 'npm run dev' running?"), R.Status), FColor::Red); }
		}));
	}));

static FAutoConsoleCommandWithWorldAndArgs GMvwShopCmd(
	TEXT("mvw.shop"), TEXT("Show Corner Grocery stock from the MVW backend (needs MVW_SERVER_KEY)"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>&, UWorld* World)
	{
		UMVWBackendSubsystem* Sub = MvwGetSubsystem(World);
		if (!Sub) { MvwShow(TEXT("MVW: backend subsystem not available"), FColor::Red); return; }
		Sub->FetchShop(TEXT("shop_corner_grocery"), FMVWBackendCallback::CreateLambda([](const FMVWBackendResult& R)
		{
			if (!R.Ok()) { MvwShow(FString::Printf(TEXT("MVW shop: failed (status %d, %s). Check MVW_SERVER_KEY."), R.Status, *R.ErrorCode()), FColor::Red); return; }
			const TArray<TSharedPtr<FJsonValue>>* Stock = nullptr;
			if (R.Json->TryGetArrayField(TEXT("stock"), Stock))
			{
				for (const TSharedPtr<FJsonValue>& V : *Stock)
				{
					const TSharedPtr<FJsonObject> O = V->AsObject();
					MvwShow(FString::Printf(TEXT("Shop: %s - %d MVC"), *O->GetStringField(TEXT("name")), (int32)O->GetNumberField(TEXT("price"))), FColor::Cyan);
				}
			}
		}));
	}));
